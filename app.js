const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');
const path = require('path');

// Use system-installed FFmpeg (from Dockerfile)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;

// IMPORTANT: point to repo file (bundled with Docker image)
const VIDEO_PATH = '/app/s.mp4';
// Performance settings
const FPS = 6;
const WIDTH = 160;
const HEIGHT = 120;

let currentFrame = 0;
let videoDuration = 0;
let lastPixels = [];
let isProcessing = false;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Get video duration
const getVideoDuration = () => {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(VIDEO_PATH, (err, metadata) => {
      if (err) {
        console.warn('ffprobe failed, fallback duration');
        resolve(60);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
};

// Initialize duration
(async () => {
  try {
    videoDuration = await getVideoDuration();
    console.log(`Video duration: ${videoDuration}s`);
    console.log(`Total frames: ${Math.floor(videoDuration * FPS)}`);
    console.log(`Resolution: ${WIDTH}x${HEIGHT}`);
  } catch (err) {
    console.error('Could not get video duration:', err);
    videoDuration = 60;
  }
})();

// Adaptive frame processing
let avgProcessingTime = 200;

const startAdaptiveProcessing = () => {
  const processFrame = () => {
    if (isProcessing || !videoDuration) return;

    const frameStart = Date.now();
    isProcessing = true;
    const seekTime = currentFrame / FPS;
    let pixelBuffer = Buffer.alloc(0);

    const outputStream = new PassThrough();
    outputStream.on('data', chunk => {
      pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
    });

    outputStream.on('end', () => {
      const pixels = [];
      for (let i = 0; i < pixelBuffer.length; i += 3) {
        pixels.push([pixelBuffer[i], pixelBuffer[i + 1], pixelBuffer[i + 2]]);
      }
      lastPixels = pixels;
      currentFrame = (currentFrame + 1) % Math.floor(videoDuration * FPS);
      isProcessing = false;

      const processingTime = Date.now() - frameStart;
      avgProcessingTime = (avgProcessingTime * 0.9) + (processingTime * 0.1);

      console.log(`✅ Frame ${currentFrame - 1}: ${processingTime}ms (avg: ${Math.round(avgProcessingTime)}ms)`);

      setTimeout(processFrame, Math.max(50, 1000 / FPS - processingTime));
    });

    ffmpeg(VIDEO_PATH)
      .seekInput(seekTime)
      .frames(1)
      .size(`${WIDTH}x${HEIGHT}`)
      .outputOptions(['-pix_fmt rgb24', '-preset ultrafast'])
      .format('rawvideo')
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        isProcessing = false;
        setTimeout(processFrame, 1000);
      })
      .pipe(outputStream);
  };

  processFrame();
};

setTimeout(startAdaptiveProcessing, 1000);

// API endpoints
app.get('/frame', (req, res) => {
  res.json({
    pixels: lastPixels,
    frame: currentFrame,
    timestamp: currentFrame / FPS,
    width: WIDTH,
    height: HEIGHT
  });
});

app.get('/info', (req, res) => {
  res.json({
    currentFrame,
    timestamp: currentFrame / FPS,
    duration: videoDuration,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    totalFrames: Math.floor(videoDuration * FPS),
    isProcessing
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'Video server running - Koyeb ready',
    frame: currentFrame,
    timestamp: currentFrame / FPS,
    duration: videoDuration,
    resolution: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    pixelsCount: lastPixels.length,
    isProcessing
  });
});

// Listen on Koyeb-assigned port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video pixel server running at http://0.0.0.0:${PORT}`);
});
