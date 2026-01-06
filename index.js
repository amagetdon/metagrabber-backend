const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
};

// Instagram 다운로드
async function downloadInstagram(url) {
  const results = [];

  try {
    const shortcode = url.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[2];
    if (!shortcode) {
      console.log('Invalid shortcode');
      return results;
    }

    console.log('Shortcode:', shortcode);

    // 1. Embed 페이지 시도
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    console.log('Fetching embed:', embedUrl);

    const embedRes = await fetch(embedUrl, { headers });
    const embedHtml = await embedRes.text();
    console.log('Embed HTML length:', embedHtml.length);

    // video_url 패턴 찾기
    const videoPatterns = [
      /"video_url"\s*:\s*"([^"]+)"/g,
      /"contentUrl"\s*:\s*"([^"]+)"/g,
      /video_url['"]\s*:\s*['"]([^'"]+)['"]/g,
    ];

    for (const pattern of videoPatterns) {
      let match;
      while ((match = pattern.exec(embedHtml)) !== null) {
        let videoUrl = match[1]
          .replace(/\\u0026/g, '&')
          .replace(/\\\//g, '/')
          .replace(/&amp;/g, '&');

        if (!results.find(r => r.url === videoUrl)) {
          console.log('Found video URL');
          results.push({ type: 'video', url: videoUrl, quality: 'HD' });
        }
      }
    }

    // 2. 이미지 추출 (비디오 없으면)
    if (results.length === 0) {
      const imgMatch = embedHtml.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
      if (imgMatch) {
        results.push({ type: 'image', url: imgMatch[1].replace(/&amp;/g, '&') });
      }

      // og:image
      const ogImgMatch = embedHtml.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
      if (ogImgMatch && !results.find(r => r.url === ogImgMatch[1])) {
        results.push({ type: 'image', url: ogImgMatch[1].replace(/&amp;/g, '&') });
      }
    }

    // 3. 외부 API 시도 (비디오 못찾으면)
    if (!results.find(r => r.type === 'video')) {
      try {
        // SnapSave API
        const snapRes = await fetch('https://snapsave.app/action.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': headers['User-Agent'],
            'Origin': 'https://snapsave.app',
            'Referer': 'https://snapsave.app/',
          },
          body: `url=${encodeURIComponent(url)}`,
        });

        if (snapRes.ok) {
          const snapData = await snapRes.text();
          const videoMatch = snapData.match(/href="([^"]+\.mp4[^"]*)"/);
          if (videoMatch) {
            results.push({ type: 'video', url: videoMatch[1], quality: 'HD' });
          }
        }
      } catch (e) {
        console.log('SnapSave failed:', e.message);
      }
    }

    console.log('Total results:', results.length);

  } catch (error) {
    console.error('Instagram error:', error.message);
  }

  return results;
}

// YouTube 다운로드 (fetch 방식)
async function downloadYouTube(url) {
  const results = [];

  try {
    let videoId = url.match(/(?:v=|\/)([\w-]{11})(?:\?|&|$)/)?.[1];
    if (!videoId) {
      videoId = url.match(/youtu\.be\/([\w-]{11})/)?.[1];
    }
    if (!videoId) return results;

    console.log('Video ID:', videoId);

    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
    const html = await response.text();

    // ytInitialPlayerResponse 추출
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (playerMatch) {
      try {
        const playerData = JSON.parse(playerMatch[1]);
        const formats = [
          ...(playerData.streamingData?.formats || []),
          ...(playerData.streamingData?.adaptiveFormats || []),
        ];

        const title = playerData.videoDetails?.title || 'YouTube Video';

        for (const format of formats) {
          if (format.url && format.mimeType?.includes('video')) {
            results.push({
              type: 'video',
              url: format.url,
              quality: format.qualityLabel || format.quality || 'Unknown',
              title,
            });
          }
        }

        const thumbnail = playerData.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url;
        if (thumbnail) {
          results.push({ type: 'image', url: thumbnail, title });
        }
      } catch (e) {
        console.log('JSON parse error:', e.message);
      }
    }

  } catch (error) {
    console.error('YouTube error:', error.message);
  }

  return results;
}

// Facebook 다운로드
async function downloadFacebook(url) {
  const results = [];

  try {
    const response = await fetch(url, { headers });
    const html = await response.text();

    const videoPatterns = [
      /"playable_url":"([^"]+)"/g,
      /"playable_url_quality_hd":"([^"]+)"/g,
      /"sd_src":"([^"]+)"/g,
      /"hd_src":"([^"]+)"/g,
    ];

    for (const pattern of videoPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        let videoUrl = match[1]
          .replace(/\\u0026/g, '&')
          .replace(/\\\//g, '/');

        if (!results.find(r => r.url === videoUrl)) {
          const isHD = match[0].includes('hd');
          results.push({ type: 'video', url: videoUrl, quality: isHD ? 'HD' : 'SD' });
        }
      }
    }

  } catch (error) {
    console.error('Facebook error:', error.message);
  }

  return results;
}

// API 엔드포인트
app.post('/download', async (req, res) => {
  const startTime = Date.now();

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log('Processing:', url);

    let results = [];

    if (url.includes('instagram.com')) {
      results = await downloadInstagram(url);
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      results = await downloadYouTube(url);
    } else if (url.includes('facebook.com') || url.includes('fb.com') || url.includes('fb.watch')) {
      results = await downloadFacebook(url);
    } else {
      return res.status(400).json({ error: 'Unsupported platform' });
    }

    const media = results.map((item, index) => ({
      ...item,
      filename: item.type === 'video'
        ? `video_${Date.now()}_${index}.mp4`
        : `image_${Date.now()}_${index}.jpg`,
    }));

    console.log(`Done in ${Date.now() - startTime}ms, ${media.length} results`);

    res.json({ success: true, media });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
