// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Enhanced CORS configuration with expanded header allowlist
app.use(cors({
  // Allow connections from your actual frontend domain
  origin: ["https://kingofapes.fun", "http://localhost:3000", "http://localhost:4003", "http://localhost:4004", "https://webtests-6it9.onrender.com", "https://www.kingofapes.fun"],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
  allowedHeaders: [
    "Content-Type", 
    "Authorization", 
    "X-Requested-With", 
    "Cache-Control", 
    "Pragma", 
    "Expires", 
    "my-custom-header"
  ]
}));

const server = http.createServer(app);

// Enhanced Socket.io configuration with better connection parameters
const io = new Server(server, {
  cors: {
    origin: ["https://kingofapes.fun", "http://localhost:3000", "http://localhost:4003", "http://localhost:4004", "https://webtests-6it9.onrender.com","https://www.kingofapes.fun"],
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    credentials: true,
    allowedHeaders: [
      "Content-Type", 
      "Authorization", 
      "X-Requested-With", 
      "Cache-Control", 
      "Pragma", 
      "Expires", 
      "my-custom-header"
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204
  },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,  // How long to wait for ping response (60 seconds)
  pingInterval: 25000, // How often to ping (25 seconds)
  upgradeTimeout: 30000, // Time for WebSocket upgrade to complete
  maxHttpBufferSize: 1e8 // Increase buffer size for larger messages
});

// MongoDB connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

// Create a reusable token filter that we can apply across all queries
const createTokenFilter = () => {
  return {
    $and: [
      // Filter out WETH and Uniswap V3 LP tokens
      { symbol: { $nin: ['WETH', 'UNI-V3-POS'] } },
      // Filter out tokens with market cap of $0
      { market_cap_usd: { $gt: 0 } }
    ]
  };
};

async function startServer() {
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db('v2'); // Connect to v2 database
    const tokensCollection = db.collection('tokens'); // Use the tokens collection in v2 database
    
    // Check available fields in the collection
    const sampleToken = await tokensCollection.findOne({});
    console.log('V2 Database - Sample token structure:', JSON.stringify(sampleToken, null, 2));
    console.log('V2 Database - Available fields:', Object.keys(sampleToken || {}).join(', '));
    
    // Set up WebSocket connection handlers
    io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);
      console.log('Client origin:', socket.handshake.headers.origin);
      
      // Handle ping events from client with pong response
      socket.on('ping', () => {
        console.log(`Ping received from ${socket.id}, sending pong`);
        socket.emit('pong');
      });
      
      // Send initial data when client connects
      sendInitialData(socket, db);
      
      // Handle global statistics request
      socket.on('get-global-stats', async () => {
        try {
          console.log(`[Server] Client ${socket.id} requested global statistics`);
          
          // Apply our filter to global stats calculation
          const tokenFilter = createTokenFilter();
          
          // Aggregate to calculate global statistics with filters
          const aggregateResult = await tokensCollection.aggregate([
            { $match: tokenFilter },
            {
              $group: {
                _id: null,
                totalVolume: { $sum: { $ifNull: ["$volume_usd_24h", 0] } },
                totalMarketCap: { $sum: { $ifNull: ["$market_cap_usd", 0] } },
                totalTokens: { $sum: 1 },
                total24hVolume: { 
                  $sum: { 
                    $add: [
                      { $ifNull: ["$volume_usd_h1", 0] },
                      { $ifNull: ["$volume_usd_h6", 0] }
                    ]
                  }
                }
              }
            }
          ]).toArray();
          
          // Extract result or use defaults
          const globalStats = aggregateResult.length > 0 ? {
            totalVolume: aggregateResult[0].totalVolume || 0,
            totalMarketCap: aggregateResult[0].totalMarketCap || 0,
            totalTokens: aggregateResult[0].totalTokens || 0,
            total24hVolume: aggregateResult[0].total24hVolume || 0
          } : {
            totalVolume: 0,
            totalMarketCap: 0,
            totalTokens: await tokensCollection.countDocuments(tokenFilter),
            total24hVolume: 0
          };
          
          console.log(`[Server] Global stats calculated (with filters): ${JSON.stringify(globalStats)}`);
          
          // Send to requesting client
          socket.emit('global-stats-update', globalStats);
          
        } catch (err) {
          console.error('[Server] Error calculating global stats:', err);
          socket.emit('error', { message: 'Failed to calculate global statistics' });
        }
      });
      
      // Handle get-tokens event for sorting and pagination
      socket.on('get-tokens', async (params) => {
        console.log('SORT DEBUG - Original params:', JSON.stringify(params));
        
        try {
          // Build sorting query based on parameters
          let sortQuery = {};
          
          // FIXED: Use the exact sort field value from the client, not trying to transform it
          if (params.sort === 'marketCap') {
            console.log('Sorting by market cap (market_cap_usd)');
            sortQuery.market_cap_usd = params.direction === 'asc' ? 1 : -1;
          } else if (params.sort === 'volume') {
            console.log('Sorting by volume (volume_usd_24h)');
            sortQuery.volume_usd_24h = params.direction === 'asc' ? 1 : -1;
          } else if (params.sort === 'blockNumber') {
            console.log('Sorting by block number (blockNumber)');
            sortQuery.blockNumber = params.direction === 'asc' ? 1 : -1;
          } else {
            // Default to price sort
            console.log('Sorting by price (price_usd)');
            sortQuery.price_usd = params.direction === 'asc' ? 1 : -1;
          }
          
          const page = params.page || 1;
          const pageSize = 10; // Adjust as needed
          
          console.log(`Using sort query:`, sortQuery);
          
          // Apply token filter to query
          const tokenFilter = createTokenFilter();
          
          // Fetch tokens with sorting, filtering, and pagination
          const tokens = await tokensCollection.find(tokenFilter)
            .sort(sortQuery)
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .toArray();
          
          console.log(`Found ${tokens.length} tokens with the applied sort and filters`);
          
          // Log the first token for debugging
          if (tokens.length > 0) {
            console.log('First token data (sample):', {
              name: tokens[0].name,
              price_usd: tokens[0].price_usd,
              market_cap_usd: tokens[0].market_cap_usd,
              volume_usd_24h: tokens[0].volume_usd_24h,
              blockNumber: tokens[0].blockNumber
            });
          } else {
            console.log('No tokens found with the current sort criteria and filters');
          }
          
          // Ensure all tokens have required fields with defaults if needed
          const transformedTokens = tokens.map(token => {
            const transformed = { ...token };
            
            // Ensure all required fields exist with defaults if needed
            transformed.price_usd = transformed.price_usd || 0;
            transformed.market_cap_usd = transformed.market_cap_usd || 0;
            transformed.volume_usd_24h = transformed.volume_usd_24h || 0;
            transformed.blockNumber = transformed.blockNumber || 0;
            
            return transformed;
          });
            
          // Count only documents that match our filter
          const totalCount = await tokensCollection.countDocuments(tokenFilter);
          const totalPages = Math.ceil(totalCount / pageSize);
          
          // Send response back to client
          socket.emit('tokens-list-update', {
            tokens: transformedTokens,
            totalPages
          });
        } catch (err) {
          console.error('Error fetching tokens:', err);
          console.error('Error details:', err.stack);
          socket.emit('error', { message: 'Failed to fetch tokens' });
        }
      });
      
      // Handle token details request
      socket.on('get-token-details', async (params) => {
        try {
          console.group('Token Details Request Diagnostics');
          console.log('Received Contract Address:', params.contractAddress);
          
          // Comprehensive lookup strategies
          const lookupStrategies = [
            // 1. Exact match (case-sensitive)
            async () => await tokensCollection.findOne({ 
              contractAddress: params.contractAddress 
            }),
            
            // 2. Case-insensitive match
            async () => await tokensCollection.findOne({ 
              contractAddress: { $regex: `^${params.contractAddress}$`, $options: 'i' } 
            }),
            
            // 3. Partial case-insensitive match
            async () => await tokensCollection.findOne({ 
              contractAddress: { $regex: params.contractAddress, $options: 'i' } 
            }),
            
            // 4. Normalized address (remove 0x prefix, convert to lowercase)
            async () => {
              const normalizedAddress = params.contractAddress.toLowerCase().replace(/^0x/, '');
              return await tokensCollection.findOne({ 
                contractAddress: { $regex: normalizedAddress, $options: 'i' } 
              });
            }
          ];

          // Track diagnostic information
          const diagnosticInfo = {
            originalAddress: params.contractAddress,
            matchAttempts: [],
            foundToken: null
          };

          // Try each lookup strategy
          for (const [index, strategy] of lookupStrategies.entries()) {
            try {
              const result = await strategy();
              diagnosticInfo.matchAttempts.push({
                strategy: index + 1,
                result: result ? 'MATCH' : 'NO MATCH'
              });

              if (result) {
                diagnosticInfo.foundToken = result;
                
                // Ensure all required fields exist with V2 schema fields
                const transformedToken = { ...result };
                transformedToken.price_usd = transformedToken.price_usd || 0;
                transformedToken.market_cap_usd = transformedToken.market_cap_usd || 0;
                transformedToken.volume_usd_24h = transformedToken.volume_usd_24h || 0;
                transformedToken.volume_usd_h1 = transformedToken.volume_usd_h1 || 0;
                transformedToken.volume_usd_h6 = transformedToken.volume_usd_h6 || 0;
                transformedToken.blockNumber = transformedToken.blockNumber || 0;
                transformedToken.pool_reserve_in_usd = transformedToken.pool_reserve_in_usd || 0;
                transformedToken.totalSupply = transformedToken.totalSupply || "0";
                transformedToken.totalSupplyRaw = transformedToken.totalSupplyRaw || "0";
                transformedToken.decimals = transformedToken.decimals || 18;
                transformedToken.__v = transformedToken.__v || 0;
                transformedToken.createdAt = transformedToken.createdAt || new Date().toISOString();
                transformedToken.updatedAt = transformedToken.updatedAt || new Date().toISOString();
                transformedToken.last_updated = transformedToken.last_updated || new Date().toISOString();
                
                console.log('Token Found - Diagnostic Details:', {
                  matchStrategy: index + 1,
                  tokenName: transformedToken.name,
                  contractAddress: transformedToken.contractAddress,
                  symbol: transformedToken.symbol
                });
                
                // Send successful response
                socket.emit('token-details', transformedToken);
                
                console.log('Diagnostic Info:', JSON.stringify(diagnosticInfo, null, 2));
                console.groupEnd();
                return;
              }
            } catch (strategyError) {
              console.warn(`Lookup Strategy ${index + 1} Failed:`, strategyError);
              diagnosticInfo.matchAttempts.push({
                strategy: index + 1,
                error: strategyError.message
              });
            }
          }

          // If no token found after all strategies
          console.warn('No token found after all lookup strategies');
          console.log('Diagnostic Info:', JSON.stringify(diagnosticInfo, null, 2));
          
          // Additional debugging - list all contract addresses in the collection
          const allAddresses = await tokensCollection.distinct('contractAddress');
          console.log('Total Unique Contract Addresses:', allAddresses.length);
          console.log('First 10 Contract Addresses:', allAddresses.slice(0, 10));
          
          // Check if address is close to any existing address
          const similarAddresses = allAddresses.filter(addr => 
            addr.toLowerCase().includes(params.contractAddress.toLowerCase()) ||
            params.contractAddress.toLowerCase().includes(addr.toLowerCase())
          );
          console.log('Similar Addresses:', similarAddresses);

          // Send error response
          socket.emit('error', { 
            message: 'Token not found',
            details: {
              contractAddress: params.contractAddress,
              diagnosticInfo
            }
          });
          
          console.groupEnd();
        } catch (err) {
          console.error('Critical error in token details request:', err);
          socket.emit('error', { 
            message: 'Failed to fetch token details', 
            error: err.message 
          });
        }
      });
      
      // Handle search tokens
      socket.on('search-tokens', async (params) => {
        try {
          console.log('Search request received:', params.query);
          
          // Get base token filter
          const baseFilter = createTokenFilter();
          
          // Add search-specific conditions
          const searchQuery = {
            $and: [
              // Include the base filter conditions
              ...baseFilter.$and,
              // Add search-specific condition
              {
                $or: [
                  { name: { $regex: params.query, $options: 'i' } },
                  { symbol: { $regex: params.query, $options: 'i' } },
                  { contractAddress: { $regex: params.query, $options: 'i' } }
                ]
              }
            ]
          };

          // Fetch all matching tokens (no pagination for search)
          const searchResults = await tokensCollection.find(searchQuery)
            .sort({ market_cap_usd: -1 })
            .toArray();

          console.log(`Found ${searchResults.length} tokens matching search query and filters`);

          // Transform results to ensure all required fields
          const transformedResults = searchResults.map(token => ({
            ...token,
            price_usd: token.price_usd || 0,
            market_cap_usd: token.market_cap_usd || 0,
            volume_usd_24h: token.volume_usd_24h || 0,
            volume_usd_h1: token.volume_usd_h1 || 0,
            volume_usd_h6: token.volume_usd_h6 || 0,
            blockNumber: token.blockNumber || 0,
            pool_reserve_in_usd: token.pool_reserve_in_usd || 0,
            totalSupply: token.totalSupply || "0",
            totalSupplyRaw: token.totalSupplyRaw || "0",
            decimals: token.decimals || 18,
            __v: token.__v || 0,
            createdAt: token.createdAt || new Date().toISOString(),
            updatedAt: token.updatedAt || new Date().toISOString(),
            last_updated: token.last_updated || new Date().toISOString()
          }));

          // Send search results back to client
          socket.emit('search-results', {
            tokens: transformedResults,
            query: params.query // Send back the query for reference
          });
        } catch (err) {
          console.error('Error performing search:', err);
          socket.emit('error', { 
            message: 'Failed to perform search',
            details: err.message
          });
        }
      });
      
      // Keep-alive periodic check
      const keepAliveInterval = setInterval(() => {
        if (socket.connected) {
          socket.emit('keep-alive', { timestamp: Date.now() });
        }
      }, 30000); // 30 seconds
      
      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        clearInterval(keepAliveInterval);
      });
    });
    
    // Set up MongoDB Change Stream
    const changeStream = tokensCollection.watch();
    
    changeStream.on('change', (change) => {
      console.log('Change detected:', change.operationType);
      
      if (change.operationType === 'update' || 
          change.operationType === 'replace' || 
          change.operationType === 'insert') {
        
        // Fetch the updated document
        tokensCollection.findOne({ _id: change.documentKey._id })
          .then(updatedToken => {
            if (!updatedToken) return;
            
            // Ensure all required fields exist with defaults if needed
            const transformedToken = { ...updatedToken };
            transformedToken.price_usd = transformedToken.price_usd || 0;
            transformedToken.market_cap_usd = transformedToken.market_cap_usd || 0;
            transformedToken.volume_usd_24h = transformedToken.volume_usd_24h || 0;
            transformedToken.blockNumber = transformedToken.blockNumber || 0;
            
            // Broadcast to all connected clients
            io.emit('token-update', transformedToken);
            
            // If this token is viewed in detail by any clients, send specific update
            io.emit('token-details-update', transformedToken);
          })
          .catch(err => {
            console.error('Error fetching updated document:', err);
          });
      }
    });
    
    // Set up top tokens change stream
    const topTokensChangeStream = tokensCollection.watch();
    
    topTokensChangeStream.on('change', async (change) => {
      try {
        const tokenFilter = createTokenFilter();
        
        const topMarketCapToken = await tokensCollection.find(tokenFilter)
          .sort({ market_cap_usd: -1 })
          .limit(1)
          .toArray();
          
        const topVolumeToken = await tokensCollection.find(tokenFilter)
          .sort({ volume_usd_24h: -1 })
          .limit(1)
          .toArray();
        
        if (topMarketCapToken.length > 0 && topVolumeToken.length > 0) {
          // Ensure all required fields exist with defaults if needed
          const transformedMarketCapToken = { ...topMarketCapToken[0] };
          transformedMarketCapToken.price_usd = transformedMarketCapToken.price_usd || 0;
          transformedMarketCapToken.market_cap_usd = transformedMarketCapToken.market_cap_usd || 0;
          transformedMarketCapToken.volume_usd_24h = transformedMarketCapToken.volume_usd_24h || 0;
          transformedMarketCapToken.blockNumber = transformedMarketCapToken.blockNumber || 0;
          
          const transformedVolumeToken = { ...topVolumeToken[0] };
          transformedVolumeToken.price_usd = transformedVolumeToken.price_usd || 0;
          transformedVolumeToken.market_cap_usd = transformedVolumeToken.market_cap_usd || 0;
          transformedVolumeToken.volume_usd_24h = transformedVolumeToken.volume_usd_24h || 0;
          transformedVolumeToken.blockNumber = transformedVolumeToken.blockNumber || 0;
          
          io.emit('top-tokens-update', {
            topMarketCapToken: transformedMarketCapToken,
            topVolumeToken: transformedVolumeToken
          });
        }
      } catch (err) {
        console.error('Error fetching top tokens:', err);
      }
    });
    
    // HTTP API endpoint for global stats
    app.get('/api/global-stats', async (req, res) => {
      try {
        console.log('[Server] Received HTTP request for global stats');
        
        // Apply our filter
        const tokenFilter = createTokenFilter();
        
        // Aggregate to calculate global statistics with filters
        const aggregateResult = await tokensCollection.aggregate([
          { $match: tokenFilter },
          {
            $group: {
              _id: null,
              totalVolume: { $sum: { $ifNull: ["$volume_usd_24h", 0] } },
              totalMarketCap: { $sum: { $ifNull: ["$market_cap_usd", 0] } },
              totalTokens: { $sum: 1 }
            }
          }
        ]).toArray();
        
        // Extract result or use defaults
        const globalStats = aggregateResult.length > 0 ? {
          totalVolume: aggregateResult[0].totalVolume || 0,
          totalMarketCap: aggregateResult[0].totalMarketCap || 0,
          totalTokens: aggregateResult[0].totalTokens || 0
        } : {
          totalVolume: 0,
          totalMarketCap: 0,
          totalTokens: await tokensCollection.countDocuments(tokenFilter)
        };
        
        console.log(`[Server] HTTP global stats response (with filters): ${JSON.stringify(globalStats)}`);
        
        res.json(globalStats);
        
      } catch (err) {
        console.error('Error calculating global stats for HTTP endpoint:', err);
        res.status(500).json({ error: 'Failed to calculate global statistics' });
      }
    });
    
    // Set up HTTP API endpoint for token details as CORS fallback
    app.get('/api/tokens/:contractAddress', async (req, res) => {
      try {
        const { contractAddress } = req.params;
        console.log(`HTTP API request for token: ${contractAddress}`);
        
        const tokenDetails = await tokensCollection.findOne({ contractAddress });
        
        if (tokenDetails) {
          // Ensure all required fields exist
          const transformedToken = { ...tokenDetails };
          transformedToken.price_usd = transformedToken.price_usd || 0;
          transformedToken.market_cap_usd = transformedToken.market_cap_usd || 0;
          transformedToken.volume_usd_24h = transformedToken.volume_usd_24h || 0;
          transformedToken.blockNumber = transformedToken.blockNumber || 0;
          
          res.json(transformedToken);
        } else {
          res.status(404).json({ error: 'Token not found' });
        }
      } catch (err) {
        console.error('Error in HTTP API:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });
    
    // Start the server
    const PORT = process.env.PORT || 4003;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
  }
}

async function sendInitialData(socket, db) {
  try {
    const tokensCollection = db.collection('tokens');
    const tokenFilter = createTokenFilter();
    
    // Send initial top tokens data with filters applied
    const topMarketCapToken = await tokensCollection.find(tokenFilter)
      .sort({ market_cap_usd: -1 })
      .limit(1)
      .toArray();
      
    const topVolumeToken = await tokensCollection.find(tokenFilter)
      .sort({ volume_usd_24h: -1 })
      .limit(1)
      .toArray();
    
    if (topMarketCapToken.length > 0 && topVolumeToken.length > 0) {
      // Ensure all required fields exist with defaults if needed
      const transformedMarketCapToken = { ...topMarketCapToken[0] };
      transformedMarketCapToken.price_usd = transformedMarketCapToken.price_usd || 0;
      transformedMarketCapToken.market_cap_usd = transformedMarketCapToken.market_cap_usd || 0;
      transformedMarketCapToken.volume_usd_24h = transformedMarketCapToken.volume_usd_24h || 0;
      transformedMarketCapToken.blockNumber = transformedMarketCapToken.blockNumber || 0;
      
      const transformedVolumeToken = { ...topVolumeToken[0] };
      transformedVolumeToken.price_usd = transformedVolumeToken.price_usd || 0;
      transformedVolumeToken.market_cap_usd = transformedVolumeToken.market_cap_usd || 0;
      transformedVolumeToken.volume_usd_24h = transformedVolumeToken.volume_usd_24h || 0;
      transformedVolumeToken.blockNumber = transformedVolumeToken.blockNumber || 0;
      
      socket.emit('top-tokens-update', {
        topMarketCapToken: transformedMarketCapToken,
        topVolumeToken: transformedVolumeToken
      });
    } else {
      console.log('No top tokens found in initial data load after applying filters');
    }
    
    // Send initial tokens list (paginated) with filters applied
    const tokens = await tokensCollection.find(tokenFilter)
      .sort({ market_cap_usd: -1 })
      .limit(10) // Default page size
      .toArray();
      
    if (tokens.length > 0) {
      console.log('Initial data - First token (sample):', {
        name: tokens[0].name,
        price_usd: tokens[0].price_usd,
        market_cap_usd: tokens[0].market_cap_usd,
        volume_usd_24h: tokens[0].volume_usd_24h
      });
    } else {
      console.log('No tokens found in initial data load after applying filters');
    }
    
    // Ensure all tokens have required fields with defaults if needed
    const transformedTokens = tokens.map(token => {
      const transformed = { ...token };
      
      // Ensure all required fields exist with defaults if needed
      transformed.price_usd = transformed.price_usd || 0;
      transformed.market_cap_usd = transformed.market_cap_usd || 0;
      transformed.volume_usd_24h = transformed.volume_usd_24h || 0;
      transformed.blockNumber = transformed.blockNumber || 0;
      
      return transformed;
    });
      
    // Count only documents that match our filter
    const totalCount = await tokensCollection.countDocuments(tokenFilter);
    const totalPages = Math.ceil(totalCount / 10);
    
    socket.emit('tokens-list-update', {
      tokens: transformedTokens,
      totalPages
    });
    
    // Also send initial global stats with filters applied
    try {
      const aggregateResult = await tokensCollection.aggregate([
        { $match: tokenFilter },
        {
          $group: {
            _id: null,
            totalVolume: { $sum: { $ifNull: ["$volume_usd_24h", 0] } },
            totalMarketCap: { $sum: { $ifNull: ["$market_cap_usd", 0] } },
            totalTokens: { $sum: 1 }
          }
        }
      ]).toArray();
      
      const globalStats = aggregateResult.length > 0 ? {
        totalVolume: aggregateResult[0].totalVolume || 0,
        totalMarketCap: aggregateResult[0].totalMarketCap || 0,
        totalTokens: aggregateResult[0].totalTokens || 0
      } : {
        totalVolume: 0,
        totalMarketCap: 0,
        totalTokens: await tokensCollection.countDocuments(tokenFilter)
      };
      
      console.log(`[Server] Initial global stats (with filters): ${JSON.stringify(globalStats)}`);
      socket.emit('global-stats-update', globalStats);
      
    } catch (err) {
      console.error('Error sending initial global stats:', err);
    }
  } catch (err) {
    console.error('Error sending initial data:', err);
  }
}

startServer().catch(console.error);
