const ALLOWED_ORIGINS = [
  'https://carbonledger.tech',
  'https://www.carbonledger.tech',
  'http://127.0.0.1:8787',
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
  };
  
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    },
  });
}

// Helper function to fetch data from Carbon Intensity API
async function fetchCarbonIntensityData() {
  const response = await fetch('https://api.carbonintensity.org.uk/regional', {
    headers: {
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch from Carbon Intensity API');
  }
  
  return response.json();
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
              region_id, timestamp, demand_actual, 
              generation_mw, carbon_intensity, renewable_percentage
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            regionResult.id,
            timestamp,
            region.demand,
            region.generationmix.reduce((sum, mix) => sum + mix.perc * region.demand / 100, 0),
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

    // For 404 responses
    if (!url.pathname.startsWith('/api/')) {
      return new Response("Not found", { 
        status: 404,
        headers: corsHeaders
      });
    }

    // Energy data endpoints
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
            e.demand_actual,
            e.generation_mw,
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
        const results = data.data[0].regions.map(region => ({
          region: region.shortname,
          timestamp: data.data[0].from,
          demand_actual: region.demand,
          generation_mw: region.generationmix.reduce((sum, mix) => sum + mix.perc * region.demand / 100, 0),
          carbon_intensity: region.intensity.forecast,
          renewable_percentage: region.generationmix
            .filter(mix => ['wind', 'solar', 'hydro', 'biomass'].includes(mix.fuel))
            .reduce((sum, mix) => sum + mix.perc, 0)
        }));

        return jsonResponse(results, request);
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
            e.demand_actual,
            e.generation_mw,
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

    // OAuth endpoints
    if (request.method === "POST" && url.pathname === "/auth/google/callback") {
      try {
        const { code } = await request.json()
        console.log('Received code from frontend, attempting token exchange...')
        
        // Exchange code for tokens
        const tokenRequestBody = new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: env.APP_URL + '/login',
          grant_type: 'authorization_code'
        })
        
        console.log('Token request configuration:', {
          url: 'https://oauth2.googleapis.com/token',
          clientId: env.GOOGLE_CLIENT_ID,
          redirectUri: env.APP_URL + '/login'
        })

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: tokenRequestBody.toString()
        })

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.text()
          console.error('Token exchange failed:', {
            status: tokenResponse.status,
            error: errorData
          })
          throw new Error(`Token exchange failed: ${errorData}`)
        }

        const tokens = await tokenResponse.json()
        console.log('Successfully exchanged code for tokens')
        
        // Get user info
        const userResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`
          }
        })

        if (!userResponse.ok) {
          const errorData = await userResponse.text()
          console.error('User info fetch failed:', {
            status: userResponse.status,
            error: errorData
          })
          throw new Error('Failed to get user info')
        }

        const userData = await userResponse.json()
        console.log('Successfully fetched user info')
        
        // Create or update user in database
        const user = {
          id: userData.sub,
          email: userData.email,
          name: userData.name,
          picture: userData.picture
        }

        try {
          // Store user in database
          await env.DB.prepare(
            `INSERT INTO users (id, email, name, picture) 
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET 
             email = excluded.email,
             name = excluded.name,
             picture = excluded.picture`
          ).bind(user.id, user.email, user.name, user.picture).run()
          
          console.log('Successfully stored user in database')

          // Create session token
          const sessionToken = crypto.randomUUID()
          
          // Store session
          await env.DB.prepare(
            `INSERT INTO sessions (token, user_id, expires_at)
             VALUES (?, ?, datetime('now', '+7 days'))`
          ).bind(sessionToken, user.id).run()
          
          console.log('Successfully created session')

          return jsonResponse({ token: sessionToken, user }, request)
        } catch (dbError) {
          console.error('Database operation failed:', dbError)
          throw new Error('Failed to store user data')
        }
      } catch (error) {
        console.error('OAuth callback error:', error)
        return jsonResponse({ error: error.message || 'Authentication failed' }, request, 500)
      }
    }

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

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      try {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '')
        
        if (token) {
          try {
            await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
          } catch (error) {
            console.error('Logout error:', error)
          }
        }

        return jsonResponse({ success: true }, request)
      } catch (error) {
        console.error('Logout error:', error)
        return jsonResponse({ error: 'Logout failed' }, request, 500)
      }
    }

    return new Response("Not found", { status: 404 });
  },
}; 