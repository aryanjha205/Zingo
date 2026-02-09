# Zingo - Modern Random Video Chat

Zingo is a premium, highly attractive random video chat web application inspired by OmeTV. It features a sleek glassmorphism UI, real-time WebRTC video communication, and secure MongoDB integration.

## Features
- **Instant Matching**: Connect with random users globally in seconds.
- **WebRTC Video**: High-quality, low-latency one-to-one video chat.
- **Real-time Text Chat**: Message your partner alongside the video feed.
- **Modern UI**: Stunning gradients, glassmorphism, and smooth animations.
- **User Safety**: Built-in reporting mechanism and moderation logging.
- **Responsive**: Fully optimized for mobile and desktop screens.

## Tech Stack
- **Backend**: Flask + Flask-SocketIO (Python)
- **Frontend**: Vanilla HTML5, CSS3, JavaScript
- **Database**: MongoDB Atlas
- **Real-time**: WebRTC + Socket.IO

## Installation

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Configure environment:
   Update the `.env` file with your details (pre-configured with provided MongoDB string).

3. Run the application:
   ```bash
   python app.py
   ```

4. Access in browser:
   Open `http://localhost:5000`

## Production Deployment
Zingo is ready for deployment on platforms like Heroku, Vercel, or Render. Ensure to use an `eventlet` or `gevent` worker for Socket.IO support.

---
Created with ❤️ by Antigravity
