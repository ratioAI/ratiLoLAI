Demo clips for the web demo's Clips library. They are FFmpeg's built-in test pictures and a sine
tone, nothing else:

    ffmpeg -f lavfi -i testsrc=size=640x360:rate=30 -f lavfi -i sine=frequency=440 -t 8 clip-a.mp4
    ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=330 -t 6 clip-b.mp4
    ffmpeg -f lavfi -i smptehdbars=size=640x360:rate=30 -f lavfi -i sine=frequency=550 -t 7 clip-c.mp4
