# TruthLens – Fake News Detection Prototype

TruthLens is an AI-powered prototype designed to detect potential misinformation in user-submitted claims. The system combines heuristic pattern detection with Groq-powered AI reasoning and fact-check verification to provide a credibility assessment in real time.

## How to Run

1. Set the required API keys (PowerShell example):
   - `setx GROQ_API_KEY "YOUR_KEY"`
   - `setx FACTCHECK_API_KEY "YOUR_KEY"`
   - Restart the terminal after setting the variables.

2. Start the server:
   - `node server.js`

3. Open the application in your browser:
   - `http://localhost:3000`

## Features

- **Credibility Index** that estimates the likelihood of misinformation  
- **Groq AI Insights** providing a summary and recommendation about the claim  
- **Virality Radar** that estimates how likely the content is to spread online  
- **Risk Signal Detection** identifying sensational language, absolute claims, and missing sources  
- **Suspicious Phrase Detection** highlighting potentially misleading wording  
- **Fact-Check Evidence Panel** displaying related results from verified fact-check databases  

## System Components

- **Frontend:** HTML, CSS, and JavaScript interface for claim submission and result visualization  
- **Backend:** Node.js server handling API requests and analysis logic  
- **AI Reasoning:** Groq API for claim interpretation and credibility analysis  
- **Verification Layer:** Google Fact Check Tools API for external evidence  

## Notes

- If the Groq API is unavailable or times out, the system automatically falls back to heuristic-based analysis.  
- This prototype currently focuses on English claims but is designed to support **multilingual NLP for Indian languages in future versions**.
