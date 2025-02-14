import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import 'dotenv/config';
import twilio from 'twilio';

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


const callKey = process.env.callKey

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
            return res.status(400).json({
                message: "Incomplete fields. 'prompt' and 'number' are required."
            });
        }

        let aiVoice = voice === "Male" ? "Derek" : "Paige";
        let background = backgroundNoise || "none";

        console.log(`Prompt: ${prompt}`);
        console.log(`Number: ${number}`);
        console.log(`Voice: ${voice}`);
        console.log(`Background Noise: ${backgroundNoise}`);


        const sendPayload = {
            phone_number: number,
            task: prompt,
            voice: aiVoice,
            background_track: background
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

        // Handle call API errors
        if (!callResponse.ok) {

            const errorBody = await callResponse.text();
            console.log(`API Error Response: ${errorBody}`);

            return res.status(404).json({
                message: `call API Error: ${callResponse.status} - ${callResponse.statusText}`
            });
        }

        // Parse and log the call AI response
        const callResult = await callResponse.json();
        console.log("call AI Response:", callResult);

        callId = callResult.call_id;

        const sms = `Hello! Great to see you trying out our New and Exciting AI Call Agent. If you want to see your call details, try something dot com and input your call id ${callId}. 
        
        Regards,
        Bajhi`;

        console.log("sending sms by twilio");
        await sendSMS(number, sms)

        // Send success response to client
        res.status(200).json({
            message: "Call initiated successfully and Call ID sent.",
            callId,
            callResult
        });
    } catch (error) {
        console.error("An error occurred:", error);

        // Send error response to client
        res.status(500).json({
            message: "An error occurred while processing the request.",
            error: error.message // Include error message for debugging
        });
    }
});


app.post('/getcalldetails', async (req, res) => {
    
    try {

        const idCall = req.body.callId
        
        const options = {
            method: 'GET',
            headers: {
                'Authorization': callKey,
                'Content-Type': 'application/json',
            },
        };

        const callDetails = await fetch(`https://api.bland.ai/v1/calls/${idCall}`, options);
        const callData = await callDetails.json();

        console.log(callData);

        const { call_id, to, from, started_at, end_at, summary, price, call_ended_by, status, transcripts } = callData;


        // Process date, time, and duration
        const infoDateTime = processDateTime(started_at, end_at);
        const structuredTranscript = formatTranscripts(transcripts);

        const { startTime, startDate, endTime, endDate, duration } = infoDateTime;

        console.log(infoDateTime);

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

        console.log(lastCallData);

        // Send limited response
        res.json({
            lastCallData
        });

    } catch (error) {
        console.error('Error fetching call details:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
});