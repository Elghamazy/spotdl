const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
dotenv.config();

const {
	GOOGLE_API_KEY,
	GOOGLE_CX,
	SPOTIFY_CLIENT_ID,
	SPOTIFY_CLIENT_SECRET,
	SOUND_CX,
	PORT,
} = process.env;

if (!GOOGLE_API_KEY || !GOOGLE_CX || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SOUND_CX) {
	console.warn('Missing one or more required env vars. See .env.example');
}

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Diagnostic: show presence of required env vars (no secret values)
const requiredEnv = ['GOOGLE_API_KEY','GOOGLE_CX','SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET','SOUND_CX'];
console.log('Env presence:', requiredEnv.map(k => `${k}=${!!process.env[k]}`).join(', '));

// Health endpoint reports which required env vars are set (boolean)
app.get('/health', (req, res) => {
	const status = {};
	requiredEnv.forEach(k => { status[k] = !!process.env[k]; });
	res.json({ env: status });
});

// Cache expiry in milliseconds (1 hour)
const CACHE_EXPIRY_MS = 60 * 60 * 1000;

// Periodically clean old cached downloads
setInterval(() => {
	try {
		const entries = fs.readdirSync(DOWNLOADS_DIR);
		for (const entry of entries) {
			const fullPath = path.join(DOWNLOADS_DIR, entry);
			try {
				const stat = fs.statSync(fullPath);
				if (stat.isDirectory()) {
					// Look for metadata file first
					const metaPath = path.join(fullPath, 'meta.json');
					let created = stat.ctimeMs;
					if (fs.existsSync(metaPath)) {
						try {
							const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
							if (m && m.createdAt) created = new Date(m.createdAt).getTime();
						} catch (e) {}
					}
					if (Date.now() - created > CACHE_EXPIRY_MS) {
						try {
							fs.rmSync(fullPath, { recursive: true, force: true });
							console.log('Removed expired cache:', fullPath);
						} catch (e) {
							console.warn('Failed to remove expired cache', fullPath, e.message);
						}
					}
				}
			} catch (e) {
				console.warn('Error checking cache entry', fullPath, e.message);
			}
		}
	} catch (e) {
		console.warn('Cache cleanup error', e.message);
	}
}, 30 * 60 * 1000); // run every 30 minutes

// Create downloads directory in project root
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
	fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
	console.log('Created downloads directory:', DOWNLOADS_DIR);
}

async function googleSearchTracks(query) {
	const q = encodeURIComponent(`${query} site:open.spotify.com/track`);
	const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${q}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Google CSE error ${res.status}`);
	const data = await res.json();
	return (data.items || []).map((item) => item.link);
}

// Search specifically targeting SoundCloud using the provided CX
async function googleSearchSoundcloud(query) {
    const q = encodeURIComponent(`${query} site:soundcloud.com`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${SOUND_CX}&q=${q}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google CSE error ${res.status}`);
    const data = await res.json();
    return (data.items || []).map((item) => item.link);
}

function extractTrackId(url) {
	const m = url && url.match(/track\/([A-Za-z0-9]+)/);
	return m ? m[1] : null;
}

async function getSpotifyToken() {
	const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
	const res = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${creds}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: 'grant_type=client_credentials',
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`Spotify token error ${res.status} ${t}`);
	}
	const json = await res.json();
	return json.access_token;
}

async function getTrackInfo(trackId, token) {
	const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`Spotify track error ${res.status} ${t}`);
	}
	return await res.json();
}

app.get('/search', async (req, res) => {
	const q = req.query.q;
	if (!q) return res.status(400).json({ error: 'Missing q parameter' });
	try {
		const links = await googleSearchTracks(q);
		if (!links.length) return res.json({ results: [] });
		const results = [];
		const token = await getSpotifyToken();
		for (const link of links) {
			const id = extractTrackId(link);
			if (!id) continue;
			try {
				const info = await getTrackInfo(id, token);
				results.push({
					track_url: link,
					track_id: id,
					name: info.name,
					artists: info.artists.map((a) => a.name),
					album: info.album && info.album.name,
					external_url: info.external_urls && info.external_urls.spotify,
					preview_url: info.preview_url,
				});
			} catch (e) {
				console.warn('track fetch error', e.message);
			}
			if (results.length >= 5) break;
		}
		res.json({ results });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: err.message });
	}
});

// Download route: downloads to local downloads directory
app.get('/download', async (req, res) => {
	let trackUrl = req.query.url || req.query.track_url;
	const qParam = req.query.q;
	// If caller provided a search query (song + artist), try the SoundCloud search CX
	if (!trackUrl && qParam) {
		try {
			const links = await googleSearchSoundcloud(qParam);
			if (links && links.length > 0) {
				console.log('Search results for q:', qParam, links[0]);
				if (links[0].includes('soundcloud.com')) {
					trackUrl = links[0];
					console.log('Using SoundCloud URL from search:', trackUrl);
				} else {
					return res.status(400).json({ error: 'First search result is not a SoundCloud URL' });
				}
			} else {
				return res.status(404).json({ error: 'No search results found' });
			}
		} catch (e) {
			console.error('SoundCloud search error:', e.message);
			return res.status(500).json({ error: 'SoundCloud search failed' });
		}
	}

	// If the provided URL is a Spotify track, try to resolve to a SoundCloud URL
	if (trackUrl && trackUrl.includes('open.spotify.com/track')) {
		try {
			const id = extractTrackId(trackUrl);
			if (id) {
				const token = await getSpotifyToken();
				const info = await getTrackInfo(id, token);
				const artists = (info.artists || []).map(a => a.name).join(' ');
				const searchQuery = `${info.name} ${artists}`;
				console.log('Searching SoundCloud for Spotify track:', searchQuery);
				const scLinks = await googleSearchSoundcloud(searchQuery);
				if (scLinks && scLinks.length > 0 && scLinks[0].includes('soundcloud.com')) {
					console.log('Resolved Spotify track to SoundCloud URL:', scLinks[0]);
					trackUrl = scLinks[0];
				} else {
					console.log('No SoundCloud match found for Spotify track; proceeding with original URL');
				}
			}
		} catch (e) {
			console.warn('Failed to map Spotify track to SoundCloud:', e.message);
		}
	}
	if (!trackUrl) return res.status(400).json({ error: 'Missing url parameter' });
	let downloadDir;
	let responded = false;
	let activeProc = null;

	const wantBase64 = (req.query.base64 === 'true' || req.query.base64 === '1' || (req.query.format && req.query.format.toLowerCase() === 'base64'));

	// Determine cache directory for this track
	const cacheKey = crypto.createHash('sha1').update(trackUrl).digest('hex');
	const cacheDir = path.join(DOWNLOADS_DIR, cacheKey);

	const serveFile = (filePath) => {
		const filename = path.basename(filePath);
		if (wantBase64) {
			try {
				const data = fs.readFileSync(filePath);
				return res.json({ filename, data: data.toString('base64') });
			} catch (e) {
				console.error('Error reading file for base64:', e.message);
				return res.status(500).json({ error: 'Failed reading cached file' });
			}
		}
		return res.download(filePath, filename, (err) => {
			if (err) console.error('Error sending file:', err.message);
		});
	};

	// If cache exists and is fresh, return cached file immediately
	try {
		if (fs.existsSync(cacheDir)) {
			const metaPath = path.join(cacheDir, 'meta.json');
			let created = fs.statSync(cacheDir).ctimeMs;
			if (fs.existsSync(metaPath)) {
				try {
					const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
					if (m && m.createdAt) created = new Date(m.createdAt).getTime();
				} catch (e) {}
			}
			if (Date.now() - created <= CACHE_EXPIRY_MS) {
				const cachedFiles = findMusicFiles(cacheDir);
				if (cachedFiles.length > 0) {
					console.log('Serving cached file for', trackUrl);
					return serveFile(cachedFiles[0]);
				}
			} else {
				// expired - remove it
				try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) {}
			}
		}
	} catch (e) {
		console.warn('Cache check error:', e.message);
	}

	const safeRespond = (fn) => {
		if (responded) return;
		responded = true;
		try { fn(); } catch (e) { console.error('response send error', e); }
	};

	const cleanupDir = () => {
		if (downloadDir && fs.existsSync(downloadDir)) {
			try { 
				fs.rmSync(downloadDir, { recursive: true, force: true }); 
				console.log('Cleaned up directory:', downloadDir);
			} catch (e) {
				console.warn('Cleanup error:', e.message);
			}
		}
	};

	const findMusicFiles = (dir) => {
		const musicFiles = [];
		const musicExtensions = ['.mp3', '.m4a', '.opus', '.flac', '.wav', '.ogg'];
		
		try {
			const entries = fs.readdirSync(dir);
			console.log(`Scanning directory ${dir}, found ${entries.length} entries:`, entries);
			
			for (const entry of entries) {
				const fullPath = path.join(dir, entry);
				try {
					const stat = fs.statSync(fullPath);
					if (stat.isFile()) {
						const ext = path.extname(entry).toLowerCase();
						if (musicExtensions.includes(ext)) {
							console.log('Found music file:', fullPath);
							musicFiles.push(fullPath);
						} else {
							console.log('Ignoring non-music file:', entry);
						}
					} else if (stat.isDirectory()) {
						// Recursively search subdirectories
						const subFiles = findMusicFiles(fullPath);
						musicFiles.push(...subFiles);
					}
				} catch (e) {
					console.warn('Error checking entry:', fullPath, e.message);
				}
			}
		} catch (e) {
			console.error('Error reading directory:', dir, e.message);
		}
		
		return musicFiles;
	};

	try {
		// Create temporary unique download subdirectory in the system temp directory
		const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
		downloadDir = path.join(os.tmpdir(), `spotdl-${cacheKey}-${uniqueId}`);
		
		console.log('Creating download directory:', downloadDir);
		fs.mkdirSync(downloadDir, { recursive: true });
		
		if (!fs.existsSync(downloadDir)) {
			return res.status(500).json({ error: 'Failed to create download directory' });
		}

		console.log('Download directory created successfully');

		// Use the directory path directly; we'll use yt-dlp / youtube-dl for downloads
		console.log('Starting download for URL:', trackUrl);
		console.log('Working directory:', process.cwd());

		let stderrOutput = '';
		let stdoutOutput = '';
		let hasFailed = false;

		// Try spotdl first, then python -m spotdl as fallback
		const tryCommand = (cmd, cmdArgs, isFallback = false) => {
			console.log(`Attempting command: ${cmd} ${cmdArgs.join(' ')}`);

			const proc = spawn(cmd, cmdArgs, {
				cwd: process.cwd(),
				shell: true
			});

			activeProc = proc;

			proc.stdout.on('data', (data) => {
				const output = data.toString();
				stdoutOutput += output;
				// Keep server logs minimal
				const line = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' | ');
				if (line) console.log('[spotdl]', line);
			});

			proc.stderr.on('data', (data) => {
				const output = data.toString();
				stderrOutput += output;
				const line = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' | ');
				if (line) console.warn('[spotdl err]', line);
			});

			proc.on('error', (err) => {
				console.error('Process error:', err.message);

				if (err.code === 'ENOENT' && !isFallback) {
					console.log('Command not found, trying fallback...');
					// If we tried `python -m yt_dlp`, fall back to the yt-dlp executable
					if (cmd === 'python' && Array.isArray(cmdArgs) && cmdArgs[0] === '-m' && (cmdArgs[1] === 'yt_dlp' || cmdArgs[1] === 'yt-dlp')) {
						const fallbackArgs = cmdArgs.slice(2);
						tryCommand('yt-dlp', fallbackArgs, true);
					} else if (cmd === 'yt-dlp') {
						tryCommand('youtube-dl', cmdArgs, true);
					} else if (cmd === 'youtube-dl') {
						hasFailed = true;
						safeRespond(() => {
							res.status(500).json({ error: 'yt-dlp / youtube-dl not found. Install yt-dlp or youtube-dl.' });
						});
						cleanupDir();
					} else {
						hasFailed = true;
						safeRespond(() => {
							res.status(500).json({ error: `Command not found: ${cmd}` });
						});
						cleanupDir();
					}
				} else {
					hasFailed = true;
					safeRespond(() => {
						res.status(500).json({ 
							error: isFallback 
								? 'spotdl not found. Install with: pip install spotdl'
								: `Command error: ${err.message}`
						});
					});
					cleanupDir();
				}
			});
			proc.on('close', (code) => {
				console.log(`Process exited with code: ${code}`);
				
				if (responded || hasFailed) {
					cleanupDir();
					return;
				}

				// Check for FFmpeg error in stderr and report friendly message
				if (stderrOutput.toLowerCase().includes('ffmpeg') && 
					(stderrOutput.toLowerCase().includes('not found') || 
					 stderrOutput.toLowerCase().includes('was not found'))) {
					safeRespond(() => {
						res.status(500).json({ 
							error: 'FFmpeg not found. Please install FFmpeg and add it to your PATH.'
						});
					});
					cleanupDir();
					return;
				}

				// Look for downloaded music files
				console.log('Looking for downloaded files in:', downloadDir);
				const files = findMusicFiles(downloadDir);

				if (files.length === 0) {
					console.error('No music files found after download');
					safeRespond(() => {
						res.status(500).json({ 
							error: 'No file was downloaded. The track may not be available or download failed.',
							exitCode: code
						});
					});
					cleanupDir();
					return;
				}

				// Move successful download into cache directory (atomic-ish)
				try {
					// remove existing cacheDir if present
					if (fs.existsSync(cacheDir)) {
						try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) {}
					}
					fs.renameSync(downloadDir, cacheDir);
					// write metadata
					const meta = { createdAt: new Date().toISOString(), source: trackUrl };
					try { fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify(meta)); } catch (e) {}
				} catch (e) {
					console.warn('Failed to move to cache dir, continuing to serve from tmp dir', e.message);
				}

				// Send the first music file found
				const filePath = path.join(cacheDir, path.basename(files[0]));
				console.log(`Sending file: ${path.basename(filePath)}`);
				console.log(`Full path: ${filePath}`);
				console.log(`File size: ${fs.statSync(filePath).size} bytes`);

				safeRespond(() => {
					if (wantBase64) {
						try {
							const data = fs.readFileSync(filePath);
							res.json({ filename: path.basename(filePath), data: data.toString('base64') });
						} catch (e) {
							console.error('Error reading file for base64:', e.message);
							res.status(500).json({ error: 'Failed reading downloaded file' });
						}
						// don't delete cached file - let cache cleanup handle it
					} else {
						res.download(filePath, path.basename(filePath), (err) => {
							if (err) {
								console.error('Error sending file:', err.message);
							} else {
								console.log('File sent successfully');
							}
						});
					}
				});
			});

			// Handle client disconnect
			req.on('close', () => {
				console.log('Client disconnected');
				if (activeProc) {
					try { activeProc.kill(); } catch (e) {}
				}
				cleanupDir();
			});
		};

			// Use yt-dlp/youtube-dl for all downloads (remove spotdl usage)
			const ytArgs = ['-x', '--audio-format', 'mp3', '-o', path.join(downloadDir, '%(title)s.%(ext)s'), trackUrl];
			// Prefer running yt-dlp as a Python module: `python -m yt_dlp` (fallbacks below)
			tryCommand('python', ['-m', 'yt_dlp', ...ytArgs]);

	} catch (err) {
		console.error('Download route error:', err);
		cleanupDir();
		if (!responded) {
			res.status(500).json({ error: err.message });
		}
	}
});

const serverPort = PORT || 3000;
const server = app.listen(serverPort, () => {
	console.log(`Server running on port ${serverPort}`);
	console.log(`Downloads directory: ${DOWNLOADS_DIR}`);
});

// Disable server timeout so long downloads won't be cut off
try {
	server.setTimeout(0);
	console.log('Server timeout disabled (setTimeout(0))');
} catch (e) {
	console.warn('Unable to set server timeout:', e.message);
}