//! ratio-audio: records the sound of one process through WASAPI process loopback and writes it as
//! 48 kHz stereo 16-bit PCM into a named pipe for FFmpeg. Also finds the game window.
//! See README.md for the protocol. Operating system interfaces only: the game process is never
//! opened, read or touched.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use serde_json::{json, Value};
use wasapi::{get_default_device, initialize_mta, AudioCaptureClient, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const SAMPLE_RATE: u64 = 48_000;
/// bytes per frame: 2 channels of 16 bit
const BLOCK: usize = 4;
/// League's game window (not the launcher)
const WINDOW_TITLE: &str = "League of Legends (TM) Client";

type Res<T> = Result<T, Box<dyn std::error::Error>>;

// --- Win32, declared by hand: only a few plain functions are needed ---

type Handle = *mut c_void;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: Rect,
    work: Rect,
    flags: u32,
}

const PIPE_ACCESS_OUTBOUND: u32 = 0x0000_0002;
const PIPE_TYPE_BYTE: u32 = 0;
const PIPE_WAIT: u32 = 0;
const ERROR_PIPE_CONNECTED: u32 = 535;
const MONITOR_DEFAULTTONEAREST: u32 = 2;
const INVALID_HANDLE: isize = -1;

#[link(name = "kernel32")]
extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer: u32,
        in_buffer: u32,
        default_timeout: u32,
        security: *const c_void,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> i32;
    fn DisconnectNamedPipe(pipe: Handle) -> i32;
    fn WriteFile(file: Handle, buffer: *const u8, bytes: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class: *const u16, title: *const u16) -> Handle;
    fn GetWindowThreadProcessId(window: Handle, process_id: *mut u32) -> u32;
    fn GetClientRect(window: Handle, rect: *mut Rect) -> i32;
    fn ClientToScreen(window: Handle, point: *mut Point) -> i32;
    fn IsIconic(window: Handle) -> i32;
    fn MonitorFromWindow(window: Handle, flags: u32) -> Handle;
    fn GetMonitorInfoW(monitor: Handle, info: *mut MonitorInfo) -> i32;
    fn EnumDisplayMonitors(
        dc: Handle,
        clip: *const Rect,
        callback: unsafe extern "system" fn(Handle, Handle, *mut Rect, isize) -> i32,
        data: isize,
    ) -> i32;
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn fail(message: impl std::fmt::Display) {
    emit(json!({ "event": "error", "message": message.to_string() }));
}

unsafe extern "system" fn collect_monitor(monitor: Handle, _dc: Handle, _rect: *mut Rect, data: isize) -> i32 {
    let list = &mut *(data as *mut Vec<isize>);
    list.push(monitor as isize);
    1
}

/// Position and size of the game window's picture (without title bar and border), its process id
/// and the screen it is on. Found by the window title; the process itself is never opened.
fn find_window() -> Value {
    unsafe {
        let window = FindWindowW(std::ptr::null(), wide(WINDOW_TITLE).as_ptr());
        if window.is_null() {
            return json!({ "event": "window", "found": false });
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, &mut pid);
        let mut client = Rect::default();
        GetClientRect(window, &mut client);
        let mut origin = Point::default();
        ClientToScreen(window, &mut origin);
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MonitorInfo { size: std::mem::size_of::<MonitorInfo>() as u32, monitor: Rect::default(), work: Rect::default(), flags: 0 };
        GetMonitorInfoW(monitor, &mut info);
        let mut monitors: Vec<isize> = Vec::new();
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), collect_monitor, &mut monitors as *mut Vec<isize> as isize);
        let index = monitors.iter().position(|handle| *handle == monitor as isize).unwrap_or(0);
        json!({
            "event": "window",
            "found": true,
            "pid": pid,
            "hwnd": window as usize as u64,
            "x": origin.x,
            "y": origin.y,
            "width": client.right - client.left,
            "height": client.bottom - client.top,
            "minimized": IsIconic(window) != 0,
            "monitor": index,
            "monitorX": info.monitor.left,
            "monitorY": info.monitor.top,
            "monitorWidth": info.monitor.right - info.monitor.left,
            "monitorHeight": info.monitor.bottom - info.monitor.top
        })
    }
}

struct Source {
    client: AudioClient,
    capture: AudioCaptureClient,
    queue: VecDeque<u8>,
}

impl Source {
    /// Everything the device has right now goes into the queue. At most half a second is kept,
    /// so a stalled reader can never make the sound lag.
    fn drain(&mut self) -> Res<()> {
        while self.capture.get_next_packet_size()?.unwrap_or(0) > 0 {
            self.capture.read_from_device_to_deque(&mut self.queue)?;
        }
        let limit = SAMPLE_RATE as usize * BLOCK / 2;
        if self.queue.len() > limit {
            let extra = (self.queue.len() - limit) / BLOCK * BLOCK;
            self.queue.drain(..extra);
        }
        Ok(())
    }
}

fn format() -> WaveFormat {
    WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE as usize, 2, None)
}

/// What one process (and its children) plays, and nothing else on the system.
fn open_game(pid: u32) -> Res<(Source, wasapi::Handle)> {
    let mut client = AudioClient::new_application_loopback_client(pid, true)?;
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
    client.initialize_client(&format(), &Direction::Capture, &mode)?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;
    Ok((Source { client, capture, queue: VecDeque::new() }, event))
}

/// The default microphone, converted by Windows to the same format.
fn open_mic() -> Res<Source> {
    let device = get_default_device(&Direction::Capture)?;
    let mut client = device.get_iaudioclient()?;
    let mode = StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 };
    client.initialize_client(&format(), &Direction::Capture, &mode)?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;
    Ok(Source { client, capture, queue: VecDeque::new() })
}

struct Job {
    pid: u32,
    pipe: String,
    game: bool,
    mic: bool,
    mic_volume: f32,
}

/// Creates the pipe, waits for FFmpeg and then writes sound until `stop` is set or FFmpeg goes away.
fn capture(job: Job, stop: Arc<AtomicBool>) -> Res<u64> {
    let _ = initialize_mta();
    let name = wide(&job.pipe);
    let pipe = unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 1 << 20, 0, 0, std::ptr::null()) };
    if pipe as isize == INVALID_HANDLE || pipe.is_null() {
        return Err(format!("could not create the pipe (error {})", unsafe { GetLastError() }).into());
    }
    emit(json!({ "event": "listening", "pipe": job.pipe }));
    // blocks until FFmpeg opens the pipe ("stop" unblocks it by opening the pipe itself)
    let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) != 0 || GetLastError() == ERROR_PIPE_CONNECTED };
    let result = if connected && !stop.load(Ordering::SeqCst) { write_sound(&job, pipe, &stop) } else { Ok(0) };
    unsafe {
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
    result
}

fn write_sound(job: &Job, pipe: Handle, stop: &AtomicBool) -> Res<u64> {
    let mut game = None;
    let mut event = None;
    if job.game {
        let (source, handle) = open_game(job.pid)?;
        game = Some(source);
        event = Some(handle);
    }
    let mut mic = if job.mic {
        match open_mic() {
            Ok(source) => Some(source),
            Err(error) => {
                fail(format!("microphone not available: {error}"));
                None
            }
        }
    } else {
        None
    };
    emit(json!({ "event": "started" }));

    let started = Instant::now();
    let mut written: u64 = 0;
    let mut chunk: Vec<u8> = Vec::with_capacity(SAMPLE_RATE as usize * BLOCK / 10);
    while !stop.load(Ordering::SeqCst) {
        // the loopback event fires when the game plays something; otherwise this is a 10 ms nap
        match &event {
            Some(handle) => {
                let _ = handle.wait_for_event(10);
            }
            None => thread::sleep(std::time::Duration::from_millis(10)),
        }
        if let Some(source) = game.as_mut() {
            source.drain()?;
        }
        if let Some(source) = mic.as_mut() {
            // a microphone that disappears must not end the recording
            if source.drain().is_err() {
                mic = None;
            }
        }
        // the clock decides how much is written: what the sources have, silence for the rest
        let due = (started.elapsed().as_micros() as u64 * SAMPLE_RATE / 1_000_000).saturating_sub(written);
        if due < SAMPLE_RATE / 100 {
            continue;
        }
        let frames = due.min(SAMPLE_RATE) as usize;
        chunk.clear();
        chunk.resize(frames * BLOCK, 0);
        if let Some(source) = game.as_mut() {
            let take = source.queue.len().min(chunk.len()) / BLOCK * BLOCK;
            for (target, byte) in chunk.iter_mut().zip(source.queue.drain(..take)) {
                *target = byte;
            }
        }
        if let Some(source) = mic.as_mut() {
            let take = source.queue.len().min(chunk.len()) / 2 * 2;
            let bytes: Vec<u8> = source.queue.drain(..take).collect();
            for (index, pair) in bytes.chunks_exact(2).enumerate() {
                let at = index * 2;
                let voice = i16::from_le_bytes([pair[0], pair[1]]) as f32 * job.mic_volume;
                let mixed = i16::from_le_bytes([chunk[at], chunk[at + 1]]) as f32 + voice;
                let sample = mixed.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                chunk[at..at + 2].copy_from_slice(&sample.to_le_bytes());
            }
        }
        let mut offset = 0usize;
        while offset < chunk.len() {
            let mut count = 0u32;
            let ok = unsafe { WriteFile(pipe, chunk[offset..].as_ptr(), (chunk.len() - offset) as u32, &mut count, std::ptr::null_mut()) };
            if ok == 0 || count == 0 {
                // FFmpeg closed its end: the recording is over
                stop.store(true, Ordering::SeqCst);
                break;
            }
            offset += count as usize;
        }
        written += frames as u64;
    }
    if let Some(source) = game.as_ref() {
        let _ = source.client.stop_stream();
    }
    if let Some(source) = mic.as_ref() {
        let _ = source.client.stop_stream();
    }
    Ok(written)
}

fn main() {
    emit(json!({ "event": "ready", "version": env!("CARGO_PKG_VERSION") }));
    let mut running: Option<(Arc<AtomicBool>, String, thread::JoinHandle<()>)> = None;
    let stop_running = |running: &mut Option<(Arc<AtomicBool>, String, thread::JoinHandle<()>)>| {
        if let Some((stop, pipe, handle)) = running.take() {
            stop.store(true, Ordering::SeqCst);
            // if FFmpeg never connected, the capture thread still waits for a reader: be that reader
            drop(std::fs::File::open(&pipe));
            let _ = handle.join();
        }
    };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(command) = serde_json::from_str::<Value>(line.trim()) else {
            if !line.trim().is_empty() {
                fail("not a JSON command");
            }
            continue;
        };
        match command["cmd"].as_str().unwrap_or("") {
            "find" => emit(find_window()),
            "start" => {
                stop_running(&mut running);
                let job = Job {
                    pid: command["pid"].as_u64().unwrap_or(0) as u32,
                    pipe: command["pipe"].as_str().unwrap_or("").to_string(),
                    game: command["game"].as_bool().unwrap_or(true),
                    mic: command["mic"].as_bool().unwrap_or(false),
                    mic_volume: command["micVolume"].as_f64().unwrap_or(0.8).clamp(0.0, 1.0) as f32,
                };
                if !job.pipe.starts_with(r"\\.\pipe\") || (job.game && job.pid == 0) {
                    fail("start needs a pipe name and the process id of the game");
                    continue;
                }
                let stop = Arc::new(AtomicBool::new(false));
                let flag = stop.clone();
                let pipe = job.pipe.clone();
                let handle = thread::spawn(move || match capture(job, flag) {
                    Ok(frames) => emit(json!({ "event": "stopped", "frames": frames })),
                    Err(error) => {
                        fail(error);
                        emit(json!({ "event": "stopped", "frames": 0 }));
                    }
                });
                running = Some((stop, pipe, handle));
            }
            "stop" => stop_running(&mut running),
            "quit" => break,
            other => fail(format!("unknown command: {other}")),
        }
    }
    stop_running(&mut running);
}
