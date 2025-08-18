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

// STABLE RESOLUTION - Using 160x120 for reliability, will work towards 240p
const FPS = 10;
const FRAME_INTERVAL = 1000 / FPS; // 100ms exactly
const WIDTH = 160;   // Stable resolution first
const HEIGHT = 120;  // Then we can increase

// SYNCHRONIZED VIDEO PLAYBACK - all servers get same timestamp
const VIDEO_START_OFFSET = parseFloat(process.env.VIDEO_START_OFFSET || 0); // Offset in seconds
let videoStartTime = Date.now() - (VIDEO_START_OFFSET * 1000); // Adjust start time by offset

let videoDuration = 0;
let lastPixels = [];
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let totalErrors = 0;

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
    console.log(`Resolution: ${WIDTH}x${HEIGHT} (stable mode)`);
    console.log(`Synchronized playback: ${FPS} FPS`);
    if (VIDEO_START_OFFSET > 0) {
      console.log(`🕒 Video starts at offset: ${VIDEO_START_OFFSET}s (${Math.floor(VIDEO_START_OFFSET/60)}:${Math.floor(VIDEO_START_OFFSET%60).toString().padStart(2,'0')})`);
    }
  } catch (err) {
    console.error('Could not get video duration:', err);
    videoDuration = 60;
  }
})();

// Calculate current synchronized timestamp
const getCurrentVideoTime = () => {
  if (!videoDuration) return 0;
  
  const elapsed = (Date.now() - videoStartTime) / 1000; // seconds since start
  const loopedTime = elapsed % videoDuration; // loop the video
  return Math.max(0, loopedTime);
};

const getCurrentFrameNumber = () => {
  const videoTime = getCurrentVideoTime();
  return Math.floor(videoTime * FPS);
};

// SIMPLIFIED frame processing with better error recovery
const processSingleFrame = async (targetTime) => {
  return new Promise((resolve) => {
    console.log(`🎬 Processing frame at ${targetTime.toFixed(2)}s`);
    
    let pixelBuffer = Buffer.alloc(0);
    const outputStream = new PassThrough();
    let streamEnded = false;
    let ffmpegInstance = null;
    
    // Shorter timeout for faster recovery
    const streamTimeout = setTimeout(() => {
      if (!streamEnded) {
        console.log(`⚠️ Frame timeout at ${targetTime.toFixed(2)}s`);
        streamEnded = true;
        if (outputStream && !outputStream.destroyed) {
          outputStream.destroy();
        }
        if (ffmpegInstance) {
          try {
            // Use the correct fluent-ffmpeg kill method
            ffmpegInstance.kill('SIGTERM');
          } catch (e) {
            // Ignore kill errors
          }
        }
        resolve(null);
      }
    }, 1500); // 1.5 second timeout
    
    outputStream.on('data', chunk => {
      if (!streamEnded) {
        pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
      }
    });
    
    outputStream.on('end', () => {
      if (!streamEnded) {
        streamEnded = true;
        clearTimeout(streamTimeout);
        
        const pixels = [];
        for (let i = 0; i < pixelBuffer.length; i += 3) {
          pixels.push([pixelBuffer[i], pixelBuffer[i + 1], pixelBuffer[i + 2]]);
        }
        
        console.log(`✅ Frame at ${targetTime.toFixed(2)}s: ${pixels.length} pixels`);
        resolve(pixels);
      }
    });
    
    outputStream.on('error', (err) => {
      if (!streamEnded) {
        streamEnded = true;
        clearTimeout(streamTimeout);
        console.error(`❌ Stream error at ${targetTime.toFixed(2)}s:`, err.message);
        resolve(null);
      }
    });
    
    // Pre-check file existence
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file missing');
      clearTimeout(streamTimeout);
      resolve(null);
      return;
    }
    
    // Create FFmpeg process with ultra-conservative settings
    try {
      ffmpegInstance = ffmpeg(VIDEO_PATH)
        .seekInput(targetTime)
        .frames(1)
        .size(`${WIDTH}x${HEIGHT}`)
        .outputOptions([
          '-pix_fmt rgb24',
          '-preset ultrafast',
          '-tune fastdecode',
          '-threads 1',
          '-avoid_negative_ts make_zero',
          '-fflags +genpts'
        ])
        .format('rawvideo')
        .on('start', () => {
          // Optional: could log start
        })
        .on('error', (err) => {
          if (!streamEnded) {
            streamEnded = true;
            clearTimeout(streamTimeout);
            console.error(`❌ FFmpeg error at ${targetTime.toFixed(2)}s:`, err.message.split('\n')[0]);
            resolve(null);
          }
        })
        .on('end', () => {
          // Process ended normally
        });
      
      ffmpegInstance.pipe(outputStream);
      
    } catch (err) {
      streamEnded = true;
      clearTimeout(streamTimeout);
      console.error('❌ Failed to create FFmpeg process:', err.message);
      resolve(null);
    }
  });
};

// Background processing with smart error recovery
let isProcessing = false;
let lastSuccessfulTime = -1;

const processFrameLoop = async () => {
  if (!videoDuration) return;
  
  // Skip if too many consecutive errors
  if (consecutiveErrors > 3) {
    console.log(`⏸️ Pausing for ${consecutiveErrors * 2} seconds due to errors`);
    await new Promise(resolve => setTimeout(resolve, consecutiveErrors * 2000));
    consecutiveErrors = Math.max(0, consecutiveErrors - 1);
    return;
  }
  
  if (isProcessing) return;
  isProcessing = true;
  
  const currentTime = getCurrentVideoTime();
  
  // Only process new frames
  if (Math.abs(currentTime - lastSuccessfulTime) < 0.05) {
    isProcessing = false;
    return;
  }
  
  const startTime = Date.now();
  const pixels = await processSingleFrame(currentTime);
  const processingTime = Date.now() - startTime;
  
  if (pixels && pixels.length > 0) {
    lastPixels = pixels;
    lastSuccessfulTime = currentTime;
    consecutiveErrors = 0;
    totalFramesProcessed++;
    
    if (processingTime > 500) {
      console.log(`⚠️ Slow processing: ${processingTime}ms`);
    }
  } else {
    consecutiveErrors++;
    totalErrors++;
    console.log(`❌ Failed frame (${consecutiveErrors} consecutive errors)`);
  }
  
  isProcessing = false;
};

// Start the processing loop
setInterval(processFrameLoop, FRAME_INTERVAL);
console.log(`🚀 Started stable video processing at ${FPS} FPS`);

// API endpoints with synchronized data
app.get('/frame', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    pixels: lastPixels,
    frame: currentFrame,
    timestamp: currentTime,
    width: WIDTH,
    height: HEIGHT,
    serverTime: Date.now(),
    videoStartTime: videoStartTime,
    synchronized: true,
    stats: {
      totalFrames: totalFramesProcessed,
      totalErrors: totalErrors,
      consecutiveErrors: consecutiveErrors
    }
  });
});

app.get('/sync', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    currentTime: currentTime,
    currentFrame: currentFrame,
    serverTime: Date.now(),
    videoStartTime: videoStartTime,
    videoDuration: videoDuration,
    fps: FPS,
    synchronized: true
  });
});

app.get('/info', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    currentFrame: currentFrame,
    timestamp: currentTime,
    duration: videoDuration,
    fps: FPS,
    frameInterval: FRAME_INTERVAL,
    width: WIDTH,
    height: HEIGHT,
    totalFrames: Math.floor(videoDuration * FPS),
    isProcessing,
    consecutiveErrors,
    videoStartTime: videoStartTime,
    serverTime: Date.now(),
    synchronized: true,
    stable: true,
    stats: {
      totalFrames: totalFramesProcessed,
      totalErrors: totalErrors,
      uptime: Math.floor((Date.now() - videoStartTime) / 1000)
    }
  });
});

app.get('/debug', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    videoPath: VIDEO_PATH,
    fileExists: fs.existsSync(VIDEO_PATH),
    workingDirectory: process.cwd(),
    filesInApp: fs.readdirSync('/app'),
    fileStats: fs.existsSync(VIDEO_PATH) ? fs.statSync(VIDEO_PATH) : null,
    currentFrame: currentFrame,
    currentTime: currentTime,
    videoDuration,
    isProcessing,
    fps: FPS,
    frameInterval: FRAME_INTERVAL,
    consecutiveErrors,
    resolution: `${WIDTH}x${HEIGHT}`,
    videoStartTime: videoStartTime,
    serverTime: Date.now(),
    synchronized: true,
    stable: true
  });
});

app.get('/', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    status: 'STABLE Synchronized Video Server - 160x120 @ 10 FPS',
    frame: currentFrame,
    timestamp: currentTime,
    duration: videoDuration,
    resolution: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    frameInterval: FRAME_INTERVAL,
    pixelsCount: lastPixels.length,
    isProcessing,
    consecutiveErrors,
    fileExists: fs.existsSync(VIDEO_PATH),
    videoStartTime: videoStartTime,
    serverTime: Date.now(),
    synchronized: true,
    stable: true
  });
});

// Listen on Koyeb-assigned port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`STABLE Synchronized Video Server running at http://0.0.0.0:${PORT}`);
  console.log(`Debug endpoint available at http://0.0.0.0:${PORT}/debug`);
  console.log(`Sync endpoint available at http://0.0.0.0:${PORT}/sync`);
  console.log(`🔒 STABLE mode: ${WIDTH}x${HEIGHT} at ${FPS} FPS`);
  console.log(`🕒 Video start time: ${new Date(videoStartTime).toISOString()}`);
  if (VIDEO_START_OFFSET > 0) {
    console.log(`⏩ Starting with ${VIDEO_START_OFFSET}s offset`);
  }
});
