# PricesV2 - Token Price WebSocket Service

A real-time WebSocket service for tracking token prices and market data using MongoDB V2 database structure.

## Features

- Real-time token price updates via WebSocket
- Global market statistics
- Token details lookup by contract address
- Pagination and sorting support
- 24h volume tracking (1h and 6h aggregations)
- Comprehensive error handling and logging
- CORS support for multiple origins

## Technical Stack

- Node.js
- Express
- Socket.IO
- MongoDB (V2 Schema)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your MongoDB connection string:
```
MONGODB_URI=your_mongodb_connection_string
PORT=4003 # Optional, defaults to 4003
```

3. Start the server:
```bash
node websocket-server.js
```

## API Endpoints

### WebSocket Events

- `get-tokens`: Get paginated list of tokens
- `get-token-details`: Get detailed information for a specific token
- `get-global-stats`: Get global market statistics
- `token-update`: Real-time token updates
- `global-stats-update`: Real-time global stats updates

### HTTP Endpoints

- `GET /api/global-stats`: Get global market statistics
- `GET /api/tokens/:contractAddress`: Get token details by contract address

## Database Schema

The service uses the V2 database schema with the following collections:
- `tokens`: Main collection for token data

## Error Handling

- Comprehensive error logging
- Fallback values for missing fields
- Multiple lookup strategies for token addresses
- Connection keep-alive monitoring

## License

MIT 