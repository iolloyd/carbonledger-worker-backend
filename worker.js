const ALLOWED_ORIGINS = [
  'https://carbonledger.tech',
  'https://www.carbonledger.tech',
  'https://app.carbonledger.tech',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'http://localhost:5173'
];

// Helper function to format the response with CORS headers
function jsonResponse(data, request, status = 200) {
  const origin = request.headers.get('Origin') || '';
  const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin);
  const corsHeaders = {
    "Access-Control-Allow-Origin": isAllowedOrigin ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };
  
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

// Helper function to fetch data from Carbon Intensity API
async function fetchCarbonIntensityData() {
  try {
    const response = await fetch('https://api.carbonintensity.org.uk/regional', {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      console.error('API error:', await response.text());
      throw new Error('Failed to fetch data');
    }

    const data = await response.json();
    console.log('Raw API Response:', JSON.stringify(data.data[0].regions[0], null, 2));

    return data;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}

export default {
  // Handle scheduled tasks
  async scheduled(event, env, ctx) {
    try {
      console.log('Starting scheduled data fetch...');
      const data = await fetchCarbonIntensityData();
      const timestamp = new Date().toISOString();
      
      // Process each region's data
      for (const region of data.data[0].regions) {
        // Map the region name to our database regions
        const regionName = region.shortname;
        
        // Get region_id
        const regionResult = await env.DB.prepare(
          'SELECT id FROM uk_regions WHERE name LIKE ?'
        ).bind(`%${regionName}%`).first();
        
        if (regionResult) {
          // Calculate renewable percentage
          const renewablePercentage = region.generationmix
            .filter(mix => ['wind', 'solar', 'hydro', 'biomass'].includes(mix.fuel))
            .reduce((sum, mix) => sum + mix.perc, 0);

          await env.DB.prepare(`
            INSERT INTO energy_usage (
              region_id, timestamp, carbon_intensity, renewable_percentage
            ) VALUES (?, ?, ?, ?)
          `).bind(
            regionResult.id,
            timestamp,
            region.intensity.forecast,
            renewablePercentage
          ).run();
        }
      }
      console.log('Successfully updated energy data');
    } catch (error) {
      console.error('Error in scheduled task:', error);
    }
  },

  // Handle HTTP requests
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log('Environment variables:', {
      APP_URL: env.APP_URL,
      request_url: request.url,
      pathname: url.pathname
    });

    const origin = request.headers.get('Origin') || '';
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin);
    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowedOrigin ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
    };
    
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    // Handle auth routes
    if (url.pathname.startsWith('/auth/')) {
      if (request.method === "GET" && url.pathname === "/auth/validate") {
        try {
          const token = request.headers.get('Authorization')?.replace('Bearer ', '')
          
          if (!token) {
            return jsonResponse({ error: 'No token provided' }, request, 401)
          }

          const session = await env.DB.prepare(
            `SELECT users.* FROM sessions 
             JOIN users ON users.id = sessions.user_id
             WHERE sessions.token = ? 
             AND sessions.expires_at > datetime('now')`
          ).bind(token).first()

          if (!session) {
            return jsonResponse({ error: 'Invalid or expired token' }, request, 401)
          }

          return jsonResponse({ user: session }, request)
        } catch (error) {
          console.error('Token validation error:', error)
          return jsonResponse({ error: 'Validation failed' }, request, 500)
        }
      }
    }

    // Handle email authentication
    if (url.pathname === '/api/auth/email/request') {
      if (request.method === 'POST') {
        try {
          const { email } = await request.json()
          
          if (!email) {
            return jsonResponse({ error: 'Email is required' }, request, 400)
          }

          // Generate a 6-digit code
          const code = Math.floor(100000 + Math.random() * 900000).toString()
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes

          // Store the code
          await env.DB.prepare(`
            INSERT INTO verification_codes (email, code, expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT (email) DO UPDATE SET
            code = excluded.code,
            expires_at = excluded.expires_at
          `).bind(email, code, expiresAt.toISOString()).run()

          // TODO: Send email with code
          // For development, log the code
          console.log('Verification code for', email, ':', code)

          return jsonResponse({ message: 'Verification code sent' }, request)
        } catch (error) {
          console.error('Error sending verification code:', error)
          return jsonResponse({ error: 'Failed to send verification code' }, request, 500)
        }
      }
    }

    if (url.pathname === '/api/auth/email/verify') {
      if (request.method === 'POST') {
        try {
          const { email, code } = await request.json()
          
          if (!email || !code) {
            return jsonResponse({ error: 'Email and code are required' }, request, 400)
          }

          // Verify the code
          const verificationResult = await env.DB.prepare(`
            SELECT * FROM verification_codes
            WHERE email = ?
            AND code = ?
            AND expires_at > datetime('now')
          `).bind(email, code).first()

          if (!verificationResult) {
            return jsonResponse({ error: 'Invalid or expired code' }, request, 400)
          }

          // Create or update user
          const user = await upsertUser(env.DB, {
            email,
            name: email.split('@')[0], // Use part before @ as name
            picture: null
          })

          // Generate session token
          const token = await createSessionToken(user)

          // Store session
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
          await env.DB.prepare(`
            INSERT INTO sessions (user_id, token, expires_at)
            VALUES (?, ?, ?)
          `).bind(user.id, token, expiresAt.toISOString()).run()

          // Delete used verification code
          await env.DB.prepare(`
            DELETE FROM verification_codes
            WHERE email = ?
          `).bind(email).run()

          return jsonResponse({ token, user }, request)
        } catch (error) {
          console.error('Error verifying code:', error)
          return jsonResponse({ error: 'Failed to verify code' }, request, 500)
        }
      }
    }

    // For non-auth routes, check API prefix
    if (!url.pathname.startsWith('/api/')) {
      return new Response("Not found", { 
        status: 404,
        headers: corsHeaders
      });
    }

    // API endpoints
    // Energy data endpoints
    if (request.method === "GET" && url.pathname.startsWith('/api/energy/usage/')) {
      console.log('Energy usage request received');
      try {
        const timeframe = url.pathname.split('/').pop(); // Get 'day', 'week', or 'month'
        let hoursToFetch;
        
        switch (timeframe) {
          case 'day':
            hoursToFetch = 24;
            break;
          case 'week':
            hoursToFetch = 24 * 7;
            break;
          case 'month':
            hoursToFetch = 24 * 30;
            break;
          default:
            return jsonResponse({ error: "Invalid timeframe. Use 'day', 'week', or 'month'" }, request, 400);
        }

        const { results } = await env.DB.prepare(`
          WITH latest_data AS (
            SELECT 
              r.name as region,
              e.timestamp,
              e.carbon_intensity,
              e.renewable_percentage,
              ROW_NUMBER() OVER (PARTITION BY r.name ORDER BY e.timestamp DESC) as rn
            FROM energy_usage e
            JOIN uk_regions r ON e.region_id = r.id
            WHERE e.timestamp >= datetime('now', ?)
          )
          SELECT 
            region,
            timestamp,
            carbon_intensity,
            renewable_percentage
          FROM latest_data
          WHERE rn = 1
          ORDER BY timestamp DESC;
        `).bind(`-${hoursToFetch} hours`).all();

        if (!results || results.length === 0) {
          // If no data in DB, fetch from external API
          const data = await fetchCarbonIntensityData();
          const timestamp = new Date().toISOString();
          
          const transformedData = data.data[0].regions.map(region => ({
            timestamp,
            region: region.shortname,
            carbon_intensity: region.intensity.forecast,
            renewable_percentage: region.generationmix
              .filter(mix => ['wind', 'solar', 'hydro', 'biomass'].includes(mix.fuel))
              .reduce((sum, mix) => sum + mix.perc, 0)
          }));

          return jsonResponse(transformedData, request);
        }

        return jsonResponse(results, request);
      } catch (error) {
        console.error('Error fetching energy usage data:', error);
        return jsonResponse({ error: "Failed to fetch energy usage data" }, request, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/energy/latest") {
      try {
        // First try to get latest data from our database
        const { results: dbResults } = await env.DB.prepare(`
          WITH latest_ts AS (
            SELECT MAX(timestamp) as max_ts FROM energy_usage
          )
          SELECT 
            r.name as region,
            e.timestamp,
            e.carbon_intensity,
            e.renewable_percentage
          FROM energy_usage e
          JOIN uk_regions r ON e.region_id = r.id
          WHERE e.timestamp = (SELECT max_ts FROM latest_ts)
          ORDER BY r.name;
        `).all();

        // If we have recent data (less than 30 minutes old), use it
        if (dbResults && dbResults.length > 0) {
          const latestTimestamp = new Date(dbResults[0].timestamp);
          const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
          
          if (latestTimestamp > thirtyMinutesAgo) {
            return jsonResponse(dbResults, request);
          }
        }

        // If we don't have recent data, fetch it from the API
        console.log('Fetching fresh data from Carbon Intensity API');
        const data = await fetchCarbonIntensityData();
        const results = await Promise.all(data.data[0].regions.map(async region => {
          // Get or create region
          const regionResult = await env.DB.prepare(
            'SELECT id FROM uk_regions WHERE name = ?'
          ).bind(region.shortname).first();

          if (regionResult) {
            // Calculate renewable percentage
            const renewablePercentage = region.generationmix
              .filter(mix => ['wind', 'solar', 'hydro', 'biomass'].includes(mix.fuel))
              .reduce((sum, mix) => sum + mix.perc, 0);

            // Store the data
            await env.DB.prepare(`
              INSERT INTO energy_usage (
                region_id, timestamp, carbon_intensity, renewable_percentage
              ) VALUES (?, ?, ?, ?)
            `).bind(
              regionResult.id,
              data.data[0].from,
              region.intensity.forecast,
              renewablePercentage
            ).run();

            return {
              region: region.shortname,
              timestamp: data.data[0].from,
              carbon_intensity: region.intensity.forecast,
              renewable_percentage: renewablePercentage
            };
          }
        }));

        return jsonResponse(results.filter(Boolean), request);
      } catch (error) {
        console.error('Error fetching energy data:', error);
        return jsonResponse({ error: "Failed to fetch energy data: " + error.message }, request, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/energy/history") {
      try {
        const params = Object.fromEntries(url.searchParams);
        const region = params.region;
        const hours = parseInt(params.hours) || 24;
        
        if (!region) {
          return jsonResponse({ error: "Region parameter is required" }, request, 400);
        }

        const { results } = await env.DB.prepare(`
          SELECT 
            r.name as region,
            e.timestamp,
            e.carbon_intensity,
            e.renewable_percentage
          FROM energy_usage e
          JOIN uk_regions r ON e.region_id = r.id
          WHERE r.name LIKE ?
          AND e.timestamp >= datetime('now', ?)
          ORDER BY e.timestamp DESC
        `).bind(
          `%${region}%`,
          `-${hours} hours`
        ).all();
        
        if (!results || results.length === 0) {
          return jsonResponse({ error: "No data found for the specified region and time range" }, request, 404);
        }
        
        return jsonResponse(results, request);
      } catch (error) {
        console.error('Error fetching energy history:', error);
        return jsonResponse({ error: "Failed to fetch energy history" }, request, 500);
      }
    }

    // Waitlist endpoint
    if (request.method === "POST" && url.pathname === "/waitlist") {
      try {
        const { name, email } = await request.json();

        if (!name || !email) {
          return jsonResponse({ error: "Name and email are required" }, request, 400);
        }

        if (!email.includes("@")) {
          return jsonResponse({ error: "Invalid email format" }, request, 400);
        }

        try {
          await env.DB.prepare(
            "INSERT INTO waitlist (name, email) VALUES (?, ?)"
          ).bind(name, email).run();

          return jsonResponse({ message: "Successfully joined waitlist" }, request, 201);
        } catch (error) {
          if (error.message.includes("UNIQUE constraint failed")) {
            return jsonResponse({ error: "Email already registered" }, request, 400);
          }
          throw error;
        }
      } catch (error) {
        console.error('Error processing request:', error);
        return jsonResponse({ error: "Internal server error" }, request, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
}; 

// Helper functions
async function upsertUser(db, userInfo) {
  const { email, name, picture } = userInfo;
  
  const result = await db.prepare(
    `INSERT INTO users (email, name, picture) 
     VALUES (?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET
     name = excluded.name,
     picture = excluded.picture
     RETURNING *`
  )
  .bind(email, name, picture)
  .first();
  
  return result;
}

async function createSessionToken(user) {
  // Create a simple token (you might want to use JWT here)
  return btoa(JSON.stringify({
    userId: user.id,
    email: user.email,
    expires: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
  }));
} 
