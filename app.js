const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');
const async = require('async');

// Use system-installed FFmpeg (from Dockerfile)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;

// Video file path (bundled with Docker image)
const VIDEO_PATH = '/app/s.mp4';

// Debug file system at startup
console.log('=== DEBUGGING FILE EXISTENCE ===');
console.log('Current working directory:', process.cwd());
console.log('VIDEO_PATH:', VIDEO_PATH);
try {
  console.log('All files in /app:', fs.readdirSync('/app'));
  console.log('Does VIDEO_PATH exist?', fs.existsSync(VIDEO_PATH));
  if (fs.existsSync(VIDEO_PATH)) {
    const stats = fs.statSync(VIDEO_PATH);
    console.log('File size:', stats.size);
    console.log('File permissions:', stats.mode.toString(8));
  }
  const allFiles = fs.readdirSync('/app', { recursive: true });
  const mp4Files = allFiles.filter(f => f.includes('.mp4'));
  console.log('All MP4 files found:', mp4Files);
} catch (error) {
  console.error('Error during file system check:', error);
}
console.log('=== END DEBUG ===');

// Performance settings
const FPS = 7; // Locked at 7 FPS
const WIDTH = 160;
const HEIGHT = 120;

let currentFrame = 0;
let videoDuration = 0;
let lastPixels = [];
let isProcessing = false;
let avgProcessingTime = 200;
let retryCount = 0;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Get video duration
const getVideoDuration = () => {
  return new Promise((resolve) => {
    console.log('Getting video duration for:', VIDEO_PATH);
    ffmpeg.ffprobe(VIDEO_PATH, (err, metadata) => {
      if (err) {
        console.warn('ffprobe failed:', err);
        console.warn('Using fallback duration');
        resolve(60);
      } else {
        console.log('ffprobe successful, duration:', metadata.format.duration);
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

// Frame processing queue
const frameQueue = async.queue((task, callback) => {
  const { seekTime, frameNumber } = task;
  const frameStart = Date.now();
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
    currentFrame = (frameNumber + 1) % Math.floor(videoDuration * FPS);
    const processingTime = Date.now() - frameStart;
    avgProcessingTime = (avgProcessingTime * 0.9) + (processingTime * 0.1);
    const actualFps = 1000 / processingTime;
    console.log(`✅ Frame ${frameNumber}: ${processingTime}ms, Actual FPS: ${actualFps.toFixed(2)}, Avg: ${Math.round(avgProcessingTime)}ms`);
    outputStream.destroy();
    pixelBuffer = Buffer.alloc(0); // Reset buffer
    retryCount = 0; // Reset retry count on success
    callback();
  });

  // Check file access
  try {
    if (!fs.existsSync(VIDEO_PATH) || !fs.accessSync(VIDEO_PATH, fs.constants.R_OK)) {
      console.error('Cannot access video file:', VIDEO_PATH);
      callback(new Error('Video file inaccessible'));
      return;
    }
  } catch (err) {
    console.error('File access error:', err);
    callback(err);
    return;
  }

  ffmpeg(VIDEO_PATH)
    .seekInput(seekTime)
    .frames(1)
    .size(`${WIDTH}x${HEIGHT}`)
    .outputOptions(['-pix_fmt rgb24', '-preset ultrafast'])
    .format('rawvideo')
    .on('error', (err) => {
      console.error('FFmpeg error:', err);
      console.error('Failed seeking to:', seekTime);
      console.error('Current frame:', frameNumber);
      try {
        const stats = fs.statSync(VIDEO_PATH);
        console.error('File stats - size:', stats.size, 'modified:', stats.mtime);
      } catch (statErr) {
        console.error('Could not get file stats:', statErr);
      }
      outputStream.destroy();
      callback(err);
    })
    .pipe(outputStream);
}, 1); // Process one frame at a time

// Start frame processing at 7 FPS
const startFrameProcessing = () => {
  setInterval(() => {
    if (!isProcessing && videoDuration) {
      isProcessing = true;
      frameQueue.push({ seekTime: currentFrame / FPS, frameNumber: currentFrame }, (err) => {
        isProcessing = false;
        if (err) {
          console.error('Queue error:', err);
          const retryDelay = Math.min(1000, 100 * Math.pow(2, retryCount++));
          console.log(`Retrying in ${retryDelay}ms`);
          setTimeout(() => {
            frameQueue.push({ seekTime: currentFrame / FPS, frameNumber: currentFrame });
          }, retryDelay);
        }
      });
    }
  }, 1000 / FPS); // 142.86ms for 7 FPS
};

setTimeout(startFrameProcessing, 1000);

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
    isProcessing,
    avgProcessingTime: Math.round(avgProcessingTime)
  });
});

app.get('/debug', (req, res) => {
  res.json({
    videoPath: VIDEO_PATH,
    fileExists: fs.existsSync(VIDEO_PATH),
    workingDirectory: process.cwd(),
    filesInApp: fs.readdirSync('/app'),
    fileStats: fs.existsSync(VIDEO_PATH) ? fs.statSync(VIDEO_PATH) : null,
    currentFrame,
    videoDuration,
    isProcessing,
    avgProcessingTime: Math.round(avgProcessingTime),
    retryCount
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
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH)
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video pixel server running at http://0.0.0.0:${PORT}`);
  console.log(`Debug endpoint available at http://0.0.0.0:${PORT}/debug`);
});
