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

// ADD DEBUGGING BLOCK RIGHT HERE
console.log('=== DEBUGGING FILE EXISTENCE ===');
console.log('Current working directory:', process.cwd());
console.log('VIDEO_PATH:', VIDEO_PATH);

try {
  // List ALL files in /app
  console.log('All files in /app:', fs.readdirSync('/app'));
  
  // Check if the exact file exists
  console.log('Does VIDEO_PATH exist?', fs.existsSync(VIDEO_PATH));
  
  // If it exists, show file stats
  if (fs.existsSync(VIDEO_PATH)) {
    const stats = fs.statSync(VIDEO_PATH);
    console.log('File size:', stats.size);
    console.log('File permissions:', stats.mode.toString(8));
  }
  
  // Check if s.mp4 exists anywhere in /app
  const allFiles = fs.readdirSync('/app', { recursive: true });
  const mp4Files = allFiles.filter(f => f.includes('.mp4'));
  console.log('All MP4 files found:', mp4Files);
  
  // Try to access the file directly
  const testBuffer = fs.readFileSync(VIDEO_PATH, { flag: 'r' });
  console.log('File can be read, first 100 bytes:', testBuffer.slice(0, 100));
  
} catch (error) {
  console.error('Error during file system check:', error);
}
console.log('=== END DEBUG ===');

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
    
    // Add pre-FFmpeg check
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file missing at processing time:', VIDEO_PATH);
      isProcessing = false;
      setTimeout(processFrame, 1000);
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
        console.error('Video path being used:', VIDEO_PATH);
        console.error('File exists check:', fs.existsSync(VIDEO_PATH));
        console.error('Current frame:', currentFrame);
        
        // Additional debug info
        try {
          const stats = fs.statSync(VIDEO_PATH);
          console.error('File stats - size:', stats.size, 'modified:', stats.mtime);
        } catch (statErr) {
          console.error('Could not get file stats:', statErr);
        }
        
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

app.get('/debug', (req, res) => {
  res.json({
    videoPath: VIDEO_PATH,
    fileExists: fs.existsSync(VIDEO_PATH),
    workingDirectory: process.cwd(),
    filesInApp: fs.readdirSync('/app'),
    fileStats: fs.existsSync(VIDEO_PATH) ? fs.statSync(VIDEO_PATH) : null,
    currentFrame,
    videoDuration,
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
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH)
  });
});

// Listen on Koyeb-assigned port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video pixel server running at http://0.0.0.0:${PORT}`);
  console.log(`Debug endpoint available at http://0.0.0.0:${PORT}/debug`);
});
