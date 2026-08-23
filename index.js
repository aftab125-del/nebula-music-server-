const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// Process safety
// -----------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error('[Server Safety Net] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Server Safety Net] Uncaught exception:', error);
});

// -----------------------------------------------------------------------------
// Supabase
// -----------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  );

  console.log('[Server] Supabase Storage client initialized.');
} else {
  console.warn(
    '[Server] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.'
  );
}

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    status: 'NebulaMusic Server is running',
    ytDlp: true,
    cookies: false,
    storage: Boolean(supabase),
  });
});

// -----------------------------------------------------------------------------
// Supabase Storage helpers
// -----------------------------------------------------------------------------

async function getSupabaseAudioUrl(videoId) {
  if (!supabase) {
    return null;
  }

  const fileName = `${videoId}.m4a`;

  try {
    const { data, error } = await supabase.storage
      .from('audio-cache')
      .list('', {
        search: fileName,
        limit: 10,
      });

    if (error) {
      console.warn(
        `[Supabase Storage] List error for ${fileName}:`,
        error.message
      );

      return null;
    }

    const exists =
      Array.isArray(data) &&
      data.some((file) => file.name === fileName);

    if (!exists) {
      return null;
    }

    const { data: publicUrlData } = supabase.storage
      .from('audio-cache')
      .getPublicUrl(fileName);

    return publicUrlData?.publicUrl || null;
  } catch (error) {
    console.warn(
      `[Supabase Storage] Check failed for ${videoId}:`,
      error.message
    );

    return null;
  }
}

async function uploadToSupabaseStorage(videoId, localFilePath) {
  if (!supabase) {
    return null;
  }

  const fileName = `${videoId}.m4a`;

  console.log(
    `[Supabase Storage] Uploading ${fileName}...`
  );

  const fileBuffer = fs.readFileSync(localFilePath);

  const { error } = await supabase.storage
    .from('audio-cache')
    .upload(fileName, fileBuffer, {
      contentType: 'audio/mp4',
      upsert: true,
    });

  if (error) {
    console.error(
      `[Supabase Storage] Upload failed:`,
      error.message
    );

    throw error;
  }

  const { data: publicUrlData } = supabase.storage
    .from('audio-cache')
    .getPublicUrl(fileName);

  return publicUrlData?.publicUrl || null;
}

// -----------------------------------------------------------------------------
// yt-dlp
// -----------------------------------------------------------------------------

const inFlightDownloads = new Map();

function processAndCacheAudio(videoId) {
  if (inFlightDownloads.has(videoId)) {
    console.log(
      `[Cache] Joining existing download: ${videoId}`
    );

    return inFlightDownloads.get(videoId);
  }

  const tempPath = path.join(
    '/tmp',
    `${videoId}.m4a`
  );

  const youtubeUrl =
    `https://www.youtube.com/watch?v=${videoId}`;

  const promise = new Promise((resolve, reject) => {
    console.log(
      `[yt-dlp] Starting extraction: ${videoId}`
    );

    const args = [
      '--no-playlist',

      // Prefer m4a audio.
      '-f',
      'bestaudio[ext=m4a]/bestaudio/best',

      // Convert fallback formats to m4a.
      '--extract-audio',
      '--audio-format',
      'm4a',

      // YouTube JS challenge support.
      '--js-runtimes',
      'deno',

      '--remote-components',
      'ejs:github',

      // Use the web player client.
      '--extractor-args',
      'youtube:player_client=web',

      // Output.
      '-o',
      tempPath,

      youtubeUrl,
    ];

    const ytdlp = spawn(
      'yt-dlp',
      args,
      {
        env: process.env,
      }
    );

    let stderr = '';
    let stdout = '';

    ytdlp.stdout.on('data', (data) => {
      const text = data.toString();

      stdout += text;

      console.log(
        `[yt-dlp stdout] ${text.trim()}`
      );
    });

    ytdlp.stderr.on('data', (data) => {
      const text = data.toString();

      stderr += text;

      console.log(
        `[yt-dlp stderr] ${text.trim()}`
      );
    });

    ytdlp.on('error', (error) => {
      cleanup();

      reject(
        new Error(
          `Unable to start yt-dlp: ${error.message}`
        )
      );
    });

    ytdlp.on('close', async (code) => {
      if (
        code !== 0 ||
        !fs.existsSync(tempPath)
      ) {
        cleanup();

        const diagnostic =
          stderr
            .trim()
            .split('\n')
            .slice(-12)
            .join('\n');

        reject(
          new Error(
            `yt-dlp exited with code ${code}.\n${diagnostic}`
          )
        );

        return;
      }

      try {
        const stats = fs.statSync(tempPath);

        if (stats.size === 0) {
          cleanup();

          reject(
            new Error(
              'yt-dlp produced an empty audio file.'
            )
          );

          return;
        }

        console.log(
          `[yt-dlp] Download complete: ${videoId} (${stats.size} bytes)`
        );

        if (!supabase) {
          cleanup();

          reject(
            new Error(
              'Supabase Storage is not configured.'
            )
          );

          return;
        }

        const uploadedUrl =
          await uploadToSupabaseStorage(
            videoId,
            tempPath
          );

        cleanup();

        if (!uploadedUrl) {
          reject(
            new Error(
              'Supabase Storage did not return a public URL.'
            )
          );

          return;
        }

        resolve({
          uploadedUrl,
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    function cleanup() {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Ignore cleanup failure.
        }
      }
    }
  });

  inFlightDownloads.set(videoId, promise);

  promise.finally(() => {
    inFlightDownloads.delete(videoId);
  });

  return promise;
}

// -----------------------------------------------------------------------------
// Stream endpoint
// -----------------------------------------------------------------------------

app.get('/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({
      error: 'Invalid YouTube video ID.',
    });
  }

  try {
    console.log(
      `[Server] Stream request: ${videoId}`
    );

    // ---------------------------------------------------------
    // 1. Check Supabase cache.
    // ---------------------------------------------------------

    const cachedUrl =
      await getSupabaseAudioUrl(videoId);

    if (cachedUrl) {
      console.log(
        `[Server] Cache hit: ${videoId}`
      );

      return res.redirect(
        302,
        cachedUrl
      );
    }

    // ---------------------------------------------------------
    // 2. Download + cache.
    // ---------------------------------------------------------

    console.log(
      `[Server] Cache miss: ${videoId}`
    );

    const result =
      await processAndCacheAudio(videoId);

    if (!result.uploadedUrl) {
      throw new Error(
        'Audio was extracted but no storage URL was returned.'
      );
    }

    console.log(
      `[Server] Returning cached audio: ${videoId}`
    );

    return res.redirect(
      302,
      result.uploadedUrl
    );
  } catch (error) {
    console.error(
      `[Server] Extraction failed for ${videoId}:`,
      error.message
    );

    if (!res.headersSent) {
      return res.status(503).json({
        error: 'Audio extraction failed.',
      });
    }
  }
});

// -----------------------------------------------------------------------------
// Diagnostic endpoint
// -----------------------------------------------------------------------------

app.get('/health/yt-dlp', async (req, res) => {
  const ytdlp = spawn(
    'yt-dlp',
    ['--version'],
    {
      env: process.env,
    }
  );

  let output = '';

  ytdlp.stdout.on('data', (data) => {
    output += data.toString();
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      return res.status(503).json({
        ok: false,
        error: 'yt-dlp is unavailable.',
      });
    }

    return res.json({
      ok: true,
      ytDlpVersion: output.trim(),
    });
  });

  ytdlp.on('error', () => {
    return res.status(503).json({
      ok: false,
      error: 'yt-dlp could not be started.',
    });
  });
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `NebulaMusic Server running on port ${PORT}`
  );
});
