const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Process safety nets to prevent yt-dlp/network errors from crashing the Node process
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server Safety Net] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server Safety Net] Uncaught Exception:', err.message, err.stack);
});

// Initialize Supabase Storage Client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log('[Server] Supabase Storage client initialized successfully.');
} else {
  console.warn('[Server] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.');
}

// Copy cookies from read-only /etc/secrets/ to writable /tmp/ at startup
const SECRET_COOKIES = '/etc/secrets/cookies.txt';
const COOKIES_PATH = '/tmp/cookies.txt';
try {
  if (fs.existsSync(SECRET_COOKIES)) {
    fs.copyFileSync(SECRET_COOKIES, COOKIES_PATH);
    console.log('[Server] Cookies copied from /etc/secrets/ to /tmp/');
  } else {
    console.warn('[Server] No cookies file found at /etc/secrets/cookies.txt');
  }
} catch (err) {
  console.error('[Server] Failed to copy cookies:', err.message);
}

// --- Supabase Storage Helpers ---

/**
 * Checks if a file named ${videoId}.m4a exists in the audio-cache Supabase Storage bucket.
 * Returns the public URL if it exists, or null if not.
 */
async function getSupabaseAudioUrl(videoId) {
  if (!supabase) return null;
  const fileName = `${videoId}.m4a`;

  try {
    const { data, error } = await supabase.storage.from('audio-cache').list('', {
      search: fileName,
      limit: 10,
    });

    if (error) {
      console.warn(`[Supabase Storage] List check error for ${fileName}:`, error.message);
      return null;
    }

    const exists = data && data.some((f) => f.name === fileName);
    if (!exists) return null;

    const { data: publicUrlData } = supabase.storage.from('audio-cache').getPublicUrl(fileName);
    return publicUrlData?.publicUrl || null;
  } catch (err) {
    console.warn(`[Supabase Storage] Check exception for ${videoId}:`, err.message);
    return null;
  }
}

/**
 * Uploads a local file to the audio-cache Supabase Storage bucket under ${videoId}.m4a.
 * Returns the public URL upon successful upload.
 */
async function uploadToSupabaseStorage(videoId, localFilePath) {
  if (!supabase) return null;
  const fileName = `${videoId}.m4a`;
  console.log(`[Supabase Storage] Uploading ${fileName}...`);

  const fileBuffer = fs.readFileSync(localFilePath);
  const { data, error } = await supabase.storage.from('audio-cache').upload(fileName, fileBuffer, {
    contentType: 'audio/mp4',
    upsert: true,
  });

  if (error) {
    console.error(`[Supabase Storage] Upload failed for ${fileName}:`, error.message);
    throw error;
  }

  console.log(`[Supabase Storage] Uploaded successfully: ${fileName}`);
  const { data: publicUrlData } = supabase.storage.from('audio-cache').getPublicUrl(fileName);
  return publicUrlData?.publicUrl || null;
}

// Tracks in-progress downloads so concurrent requests for the same song
// wait for the same download & upload task instead of starting duplicate yt-dlp calls.
const inFlightDownloads = new Map();

function processAndCacheAudio(videoId) {
  if (inFlightDownloads.has(videoId)) {
    console.log(`[Cache] Attaching to existing in-flight download: ${videoId}`);
    return inFlightDownloads.get(videoId);
  }

  const tempPath = path.join('/tmp', `${videoId}.m4a.tmp`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const processPromise = new Promise((resolve, reject) => {
    console.log(`[Cache] Downloading via yt-dlp to temp: ${videoId}`);
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--cookies', COOKIES_PATH,
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=web',
      '--remote-components', 'ejs:github',
      '-o', tempPath,
      url
    ]);

    ytdlp.stderr.on('data', (data) => {
      console.log(`[yt-dlp]: ${data}`);
    });

    ytdlp.on('close', async (code) => {
      if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        console.log(`[Cache] yt-dlp download complete: ${videoId}`);
        try {
          let uploadedUrl = null;
          if (supabase) {
            uploadedUrl = await uploadToSupabaseStorage(videoId, tempPath);
          }
          // Clean up local temp file after upload
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
          }
          resolve({ uploadedUrl, tempPath });
        } catch (uploadErr) {
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
          }
          reject(uploadErr);
        }
      } else {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    ytdlp.on('error', (error) => {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
      reject(error);
    });
  });

  inFlightDownloads.set(videoId, processPromise);
  processPromise.finally(() => inFlightDownloads.delete(videoId));

  return processPromise;
}

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.json({ status: 'NebulaMusic Server is running!' });
});

// Stream audio - serves from Supabase Storage cache if available, otherwise downloads and uploads
app.get('/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    // 1. Check Supabase Storage cache first
    const cachedUrl = await getSupabaseAudioUrl(videoId);
    if (cachedUrl) {
      console.log(`[Server] Serving from Supabase Storage: ${videoId}`);
      return res.redirect(302, cachedUrl);
    }

    // 2. Not cached: Download via yt-dlp to temp file -> Upload to Supabase Storage
    console.log(`[Server] Not in Supabase Storage, downloading: ${videoId}`);
    const { uploadedUrl } = await processAndCacheAudio(videoId);

    if (uploadedUrl) {
      console.log(`[Server] Redirecting to uploaded Supabase Storage audio: ${videoId}`);
      return res.redirect(302, uploadedUrl);
    } else {
      throw new Error('Supabase Storage client is not configured.');
    }

  } catch (error) {
    console.error(`[Server] Extraction Error for ${videoId}:`, error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: `Audio extraction failed: ${error.message}` });
    }
  }
});

// Get audio URL (kept as backup)
app.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio/best" --get-url --cookies ${COOKIES_PATH} --no-check-certificates --extractor-args "youtube:player_client=web" --remote-components "ejs:github" "${url}"`;
    const { stdout } = await execAsync(command, { timeout: 30000 });
    const streamUrl = stdout.trim();
    if (!streamUrl) throw new Error('No stream URL returned');
    res.json({ url: streamUrl, videoId: videoId });
  } catch (error) {
    console.error(`[Server] Audio URL Error for ${videoId}:`, error.message);
    res.status(503).json({ error: `Audio extraction failed: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`NebulaMusic Server running on port ${PORT}`);
});