// index.js

// --- DEPENDENCIES (CommonJS Syntax) ---
const express = require('express');
// CORRECTED IMPORT: The YtDlpWrap constructor is on the 'default' export of the module.
const YtDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config(); // Loads .env file contents into process.env

// --- SETUP ---
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

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

// --- API ENDPOINT ---
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
                // Resolve only after the process closes
                if (!downloadedFile) {
                    // This handles cases where the link is invalid/private and yt-dlp exits without downloading
                    reject(new Error('DownloadFailed'));
                } else {
                    resolve();
                }
            })
            .on('error', (err) => reject(err));
        });

        if (!downloadedFile || !fs.existsSync(downloadedFile)) {
             // This is a fallback, the main check is in the 'close' event handler
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
        const result = await transcribeAndTranslateWithGemini(audioFilePath);
        console.log('[3/3] Process complete.');

        // --- RESPONSE ---
        res.status(200).json({
            sourceUrl: url,
            ...result, // Spread the structured result from Gemini
        });

    } catch (error) {
        // --- IMPROVED ERROR HANDLING ---
        if (error.message === 'DownloadFailed') {
            return res.status(400).json({ 
                error: 'Content could not be downloaded. The URL may be invalid, private, or the content is unavailable.' 
            });
        }
        console.error('An error occurred during the transcription process:', error);
        res.status(500).json({ error: 'An internal server error occurred.', details: error.message });
    } finally {
        // --- CLEANUP ---
        if (downloadedFile && fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
        if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        console.log('Temporary files cleaned up.');
    }
});

// --- GEMINI TRANSCRIPTION & TRANSLATION FUNCTION ---
/**
 * Transcribes an audio file and provides a structured JSON output.
 * @param {string} filePath - Path to the audio file (WAV format recommended).
 * @returns {Promise<object>} - An object with language, original transcript, and translation.
 */
async function transcribeAndTranslateWithGemini(filePath) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const audioBytes = fs.readFileSync(filePath).toString("base64");
        const audioPart = {
            inlineData: { data: audioBytes, mimeType: "audio/wav" },
        };
        
        // Updated prompt to request a JSON object with more vigilant language detection
        const prompt = `
            Analyze the provided audio and return a single, minified JSON object with no markdown formatting.
            The JSON object must have these exact keys: "language_detected", "original_transcript", "english_translation".
            1.  "language_detected": Identify the primary spoken language and provide its two-letter ISO 639-1 code (e.g., "en", "es", "ur"). Be very careful when distinguishing between similar languages like Hindi (hi) and Urdu (ur). Analyze vocabulary and phrasing to make the correct choice.
            2.  "original_transcript": Transcribe the audio verbatim in its original language.
            3.  "english_translation": Translate the original transcript into English. If the original is already in English, this field should contain the same text as "original_transcript".
        `;

        const result = await model.generateContent([prompt, audioPart]);
        let jsonResponse = result.response.text();

        // **FIX:** Clean the response string to remove markdown fences
        if (jsonResponse.startsWith('```json')) {
            jsonResponse = jsonResponse.substring(7, jsonResponse.length - 3).trim();
        }

        // Safely parse the JSON response from the model
        try {
            return JSON.parse(jsonResponse);
        } catch (parseError) {
            console.error("Failed to parse JSON response from Gemini:", jsonResponse);
            throw new Error("Received an invalid response format from the AI model.");
        }

    } catch (error) {
        console.error("Error during Gemini processing:", error);
        throw new Error("Failed to transcribe or translate audio with Gemini.");
    }
}

// --- START SERVER ---
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log('Send a POST request to /transcribe with a JSON body: { "url": "your_reel_url" }');
});
