const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'NebulaMusic Server is running!' });
});

// Get audio stream URL from YouTube video ID
app.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    console.log(`[Server] Getting audio for video: ${videoId}`);
    
    const info = await ytdl.getInfo(videoId);
    
    // Get best audio format
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    
    if (!audioFormats || audioFormats.length === 0) {
      return res.status(404).json({ error: 'No audio stream found' });
    }
    
    // Sort by bitrate and pick highest quality
    audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const bestAudio = audioFormats[0];
    
    console.log(`[Server] Found audio stream: ${bestAudio.mimeType} @ ${bestAudio.audioBitrate}kbps`);
    
    res.json({
      url: bestAudio.url,
      mimeType: bestAudio.mimeType,
      bitrate: bestAudio.audioBitrate,
      title: info.videoDetails.title,
      duration: info.videoDetails.lengthSeconds
    });
    
  } catch (error) {
    console.error(`[Server] Error getting audio for ${videoId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Search YouTube by song title and artist
app.get('/search', async (req, res) => {
  const { q } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }
  
  try {
    // We use YouTube Data API for search - just return that we need a videoId
    res.json({ message: 'Use YouTube Data API for search, then call /audio/:videoId' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`NebulaMusic Server running on port ${PORT}`);
});