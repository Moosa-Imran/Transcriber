// index.js

// --- DEPENDENCIES (CommonJS Syntax) ---
const express = require('express');
const YtDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// --- SETUP ---
const app = express();
const port = process.env.PORT || 3050;

// Setup view engine and static files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// Initialize yt-dlp
const ytDlpWrap = new YtDlpWrap();

// Initialize Google Gemini AI
if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not defined in your .env file.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define a path for the temporary directory
const tempDir = path.join(__dirname, 'temp');

// Create a temporary directory to store audio files if it doesn't exist
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// --- ROUTES ---

// Frontend Route
app.get('/', (req, res) => {
    res.render('index');
});

// API Endpoint
app.post('/transcribe', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Instagram Reel URL is required.' });
    }

    const uniqueId = Date.now();
    const audioFilePath = path.join(tempDir, `${uniqueId}.wav`);
    let downloadedFile = '';

    try {
        // --- STEP 1: DOWNLOAD AUDIO FROM THE REEL ---
        console.log(`[1/3] Downloading audio from: ${url}`);
        await new Promise((resolve, reject) => {
            ytDlpWrap.exec([
                url,
                '-f', 'bestaudio',
                '-o', path.join(tempDir, `${uniqueId}.%(ext)s`)
            ])
            .on('ytDlpEvent', (eventType, eventData) => {
                 if (eventType === 'download' && eventData.includes('Destination:')) {
                    downloadedFile = eventData.split('Destination: ')[1].trim();
                 }
            })
            .on('close', () => {
                if (!downloadedFile) {
                    reject(new Error('DownloadFailed'));
                } else {
                    resolve();
                }
            })
            .on('error', (err) => reject(err));
        });

        if (!downloadedFile || !fs.existsSync(downloadedFile)) {
            throw new Error('DownloadFailed');
        }
        console.log(`[1/3] Download complete. File saved to: ${downloadedFile}`);

        // --- STEP 2: CONVERT AUDIO TO WAV FORMAT ---
        console.log(`[2/3] Converting to WAV format...`);
        await new Promise((resolve, reject) => {
            ffmpeg(downloadedFile)
                .toFormat('wav')
                .audioFrequency(16000)
                .audioChannels(1)
                .on('end', () => {
                    console.log('[2/3] Conversion successful.');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('[2/3] FFmpeg error:', err);
                    reject(err);
                })
                .save(audioFilePath);
        });

        // --- STEP 3: TRANSCRIBE & TRANSLATE WITH GEMINI ---
        console.log(`[3/3] Starting transcription and translation for: ${audioFilePath}`);
        const transcript = await transcribeAndTranslateWithGemini(audioFilePath);
        console.log('[3/3] Process complete.');

        // --- RESPONSE ---
        res.status(200).json({
            sourceUrl: url,
            transcript: transcript, // Simplified response
        });

    } catch (error) {
        if (error.message === 'DownloadFailed') {
            return res.status(400).json({ 
                error: 'Content could not be downloaded. The URL may be invalid, private, or the content is unavailable.' 
            });
        }
        console.error('An error occurred during the transcription process:', error);
        res.status(500).json({ error: 'An internal server error occurred.', details: error.message });
    } finally {
        if (downloadedFile && fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
        if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        console.log('Temporary files cleaned up.');
    }
});

// --- GEMINI TRANSCRIPTION & TRANSLATION FUNCTION ---
async function transcribeAndTranslateWithGemini(filePath) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const audioBytes = fs.readFileSync(filePath).toString("base64");
        const audioPart = {
            inlineData: { data: audioBytes, mimeType: "audio/wav" },
        };
        
        const prompt = `
            Analyze the provided audio.
            First, transcribe it in its original language.
            Then, if the transcription is not in English, translate it to English.
            Provide ONLY the final English text as your response, with no extra formatting or explanations.
        `;

        const result = await model.generateContent([prompt, audioPart]);
        return result.response.text().trim();

    } catch (error) {
        console.error("Error during Gemini processing:", error);
        throw new Error("Failed to transcribe or translate audio with Gemini.");
    }
}

// --- START SERVER ---
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
