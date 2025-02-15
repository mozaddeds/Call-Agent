import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import 'dotenv/config';

import twilio from 'twilio';

import { google } from 'googleapis';
import { readFile } from 'fs/promises';



const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


const callKey = process.env.callKey

const credentialsPath = './credentials.json';

async function authorize() {
    const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const { client_email, private_key } = credentials;

    const auth = new google.auth.JWT(client_email, null, private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    return auth;
}


async function insertAtTop(data) {
    try {
        const auth = await authorize();
        const sheets = google.sheets({ version: 'v4', auth });

        const spreadsheetId = process.env.spreadsheetId;
        const sheetName = "Sheet1";

        // Convert structuredTranscript to a string
        const structuredTranscriptStr = JSON.stringify(data.structuredTranscript);

        // Format data as a 2D array for Google Sheets
        const newRow = [
            [
                data.call_id,
                data.to,
                data.from,
                data.startTime,
                data.startDate,
                data.endTime,
                data.endDate,
                data.duration,
                data.summary,
                data.price,
                data.call_ended_by,
                data.status,
                structuredTranscriptStr
            ]
        ];

        // 1️⃣ Fetch existing data from the sheet
        const getResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:N`,
        });

        let rows = getResponse.data.values || [];

        // 2️⃣ Insert latest data at row 2:2
        rows.splice(0, 0, newRow[0]); // Insert new row at the top

        // 3️⃣ Update the sheet with modified data
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A:N`,
            valueInputOption: "RAW",
            requestBody: { values: rows },
        });

        console.log("✅ Latest call data inserted at the top of Google Sheet.");

    } catch (error) {
        console.error("❌ Error updating Google Sheet:", error);
    }
}


function processDateTime(startTimestamp, endTimestamp = null) {
    function formatDateTime(timestamp) {
        const date = new Date(timestamp);
        let hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12; // Convert to 12-hour format
        const formattedTime = `${hours}:${minutes} ${ampm}`;

        const day = date.getDate();
        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        const formattedDate = `${day} ${month}, ${year}`;

        return { formattedTime, formattedDate };
    }

    const start = formatDateTime(startTimestamp);
    let result = {
        startTime: start.formattedTime,
        startDate: start.formattedDate
    };

    if (endTimestamp) {
        const end = formatDateTime(endTimestamp);
        const startDate = new Date(startTimestamp);
        const endDate = new Date(endTimestamp);
        const durationMs = endDate - startDate;
        const durationMinutes = Math.floor(durationMs / (1000 * 60));
        const durationSeconds = Math.floor((durationMs % (1000 * 60)) / 1000);
        const duration = `${durationMinutes} minutes ${durationSeconds} seconds`;

        result.endTime = end.formattedTime;
        result.endDate = end.formattedDate;
        result.duration = duration;
    }

    return result;
}

function formatTranscripts(transcripts) {
    function formatTimestamp(timestamp) {
        const { startTime, startDate } = processDateTime(timestamp);
        return `${startTime}, ${startDate}`;
    }

    let conversation = [];

    for (let i = 0; i < transcripts.length; i += 2) {
        if (i + 1 < transcripts.length) {
            conversation.push({
                user: transcripts[i].user,
                text: transcripts[i].text,
                created_at: formatTimestamp(transcripts[i].created_at),
                user2: transcripts[i + 1].user,  // Different key to avoid overwriting
                text2: transcripts[i + 1].text,
                created_at2: formatTimestamp(transcripts[i + 1].created_at)
            });
        } else {
            conversation.push({
                user: transcripts[i].user,
                text: transcripts[i].text,
                created_at: formatTimestamp(transcripts[i].created_at)
            });
        }
    }

    return { conversation };
}

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendSMS(to, message) {
    try {
        const response = await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER, // Your Twilio number
            to: to, // Recipient's phone number
        });
        console.log("SMS sent");
    } catch (error) {
        console.error("Twilio SMS Error: ", error.message);
    }
}




let lastCallData = null;
let callId = null;


app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.post('/sendaicall', async (req, res) => {
    try {
        const { prompt, number, voice, backgroundNoise } = req.body;

        if (!prompt || !number) {
            return res.status(400).json({ message: "Missing required fields: 'prompt' and 'number'." });
        }

        let aiVoice = voice === "Male" ? "Derek" : "Paige";
        let background = backgroundNoise || "none";

        const sendPayload = {
            phone_number: number,
            task: prompt,
            voice: aiVoice,
            background_track: background,
            webhook: process.env.webhookUrl
        };

        const options = {
            method: 'POST',
            headers: {
                'Authorization': callKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(sendPayload)
        };

        const callResponse = await fetch('https://api.bland.ai/v1/calls', options);

        if (!callResponse.ok) {
            const errorBody = await callResponse.text();
            console.log(`API Error Response: ${errorBody}`);
            return res.status(404).json({ message: `call API Error: ${callResponse.status}` });
        }

        const callResult = await callResponse.json();
        const callId = callResult.call_id;

        // Send SMS
        const smsMessage = `Your AI call was initiated. Call ID: ${callId}. Visit something.com for details.`;
        console.log("Sending SMS via Twilio...");
        await sendSMS(number, smsMessage);

        res.status(200).json({
            message: "Call initiated and Call ID sent via SMS.",
            callId,
            callResult
        });

    } catch (error) {
        console.error("Error in /sendaicall:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});


app.post('/addtosheet', async (req, res) => {
    try {
        const { call_id, to, from, started_at, end_at, summary, price, call_ended_by, status, transcripts } = req.body;

        // Process date, time, and duration
        const infoDateTime = processDateTime(started_at, end_at);
        const structuredTranscript = transcripts ? formatTranscripts(transcripts) : [];

        const { startTime, startDate, endTime, endDate, duration } = infoDateTime;

        // Format call data
        const formattedData = {
            call_id,
            to,
            from,
            startTime,
            startDate,
            endTime,
            endDate,
            duration,
            summary,
            price,
            call_ended_by,
            status,
            structuredTranscript,
        };

        // Insert latest data at the top of the sheet
        await insertAtTop(formattedData);

        res.json({
            message: "Call data successfully stored in Google Sheets at the top",
            callData: formattedData,
        });

    } catch (error) {
        console.error('Error adding call details to sheet:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});


app.post('/getcalldetails', async (req, res) => {

    try {

        const number = req.body.number

        const options = {
            method: 'GET',
            headers: {
                'Authorization': callKey,
                'Content-Type': 'application/json',
            },
        };

        // change here from const lastcall to getcallDetails.json

        const lastCall = await fetch(`https://api.bland.ai/v1/calls?to_number=${number}&ascending=false`, options);
        const callData = await lastCall.json();


        // Check if calls exist
        if (!callData.calls || callData.calls.length === 0) {
            return res.status(404).json({ error: 'No call records found for this number.' });
        }

        const c_id = callData.calls[0].c_id;  // ✅ This will now always be valid


        const getCallDetails = await fetch(`https://api.bland.ai/v1/calls/${c_id}`, options);
        const callDetails = await getCallDetails.json();


        const { call_id, to, from, started_at, end_at, summary, price, call_ended_by, status, transcripts } = callDetails;


        // Process date, time, and duration
        const infoDateTime = processDateTime(started_at, end_at);
        const structuredTranscript = formatTranscripts(transcripts);

        const { startTime, startDate, endTime, endDate, duration } = infoDateTime;

        console.log("info date time ", infoDateTime);

        // Store call data for the `/calldetails` endpoint
        lastCallData = {
            call_id,
            to,
            from,
            startTime,
            startDate,
            endTime,
            endDate,
            duration,
            summary,
            price,
            call_ended_by,
            status,
            structuredTranscript
        };

        console.log("Sending data to webhook: ", lastCallData);

        // Send data to webhook
        const webhookResponse = await fetch(process.env.wpwebhook, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(lastCallData)
        });

        if (!webhookResponse.ok) {
            console.error("Failed to send data to webhook:", await webhookResponse.text());
            return res.status(500).json({ error: "Failed to send data to webhook." });
        }

        console.log("Data successfully sent to webhook.");

        // Send success response
        res.json({ message: "Data successfully sent to webhook." });


    } catch (error) {
        console.error('Error fetching call details:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
});