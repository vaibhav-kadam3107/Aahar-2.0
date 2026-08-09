export default async function (req: Request): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method Not Allowed. Please send a POST request.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // 1. Session Validation
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
    if (!baseUrl) {
      return new Response(
        JSON.stringify({ error: 'INSFORGE_BASE_URL environment variable is not configured.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const sessionResponse = await fetch(`${baseUrl}/api/auth/sessions/current`, {
      method: 'GET',
      headers: { 'Authorization': authHeader },
    });

    if (!sessionResponse.ok) {
      const errText = await sessionResponse.text();
      return new Response(
        JSON.stringify({ error: `Session validation failed: ${errText}` }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const sessionData = await sessionResponse.json();
    const userId = sessionData.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'User ID not found in session' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    const body = await req.json().catch(() => ({}));
    const { image_path, idempotency_key } = body;

    if (!image_path) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: image_path' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (!idempotency_key) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: idempotency_key' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate signed download URL helper
    const getDownloadUrl = async (path: string): Promise<string> => {
      const downloadStrategyResponse = await fetch(
        `${baseUrl}/api/storage/buckets/meals/download-strategy/objects/${path}`,
        { method: 'GET', headers: { 'Authorization': authHeader } }
      );
      if (downloadStrategyResponse.ok) {
        const strategyData = await downloadStrategyResponse.json();
        let imageUrl = strategyData.url;
        if (strategyData.method === 'direct' && imageUrl.startsWith('/')) {
          imageUrl = `${baseUrl}${imageUrl}`;
        }
        return imageUrl;
      }
      return '';
    };

    // 2. IDEMPOTENCY CHECK
    const fetchMealRes = await fetch(
      `${baseUrl}/api/database/records/meals?idempotency_key=eq.${idempotency_key}`,
      { method: 'GET', headers: { 'Authorization': authHeader } }
    );

    if (!fetchMealRes.ok) {
      const errText = await fetchMealRes.text();
      return new Response(
        JSON.stringify({ error: `Database fetch error: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const existingMeals = await fetchMealRes.json();

    if (existingMeals && existingMeals.length > 0) {
      const fetchItemsRes = await fetch(
        `${baseUrl}/api/database/records/meal_food_items?meal_id=eq.${existingMeals[0].id}`,
        { method: 'GET', headers: { 'Authorization': authHeader } }
      );
      const foodItems = fetchItemsRes.ok ? await fetchItemsRes.json() : [];
      const imageUrl = await getDownloadUrl(existingMeals[0].image_path);

      return new Response(
        JSON.stringify({
          meal: existingMeals[0],
          food_items: foodItems,
          imageUrl,
          is_duplicate: true,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. RATE LIMITING CHECK (max 20 calls per user per 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fetchRecentRes = await fetch(
      `${baseUrl}/api/database/records/meals?user_id=eq.${userId}&created_at=gte.${oneDayAgo}&select=id`,
      { method: 'GET', headers: { 'Authorization': authHeader } }
    );

    if (!fetchRecentRes.ok) {
      const errText = await fetchRecentRes.text();
      return new Response(
        JSON.stringify({ error: `Rate check fetch error: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const recentMeals = await fetchRecentRes.json();
    if (recentMeals && recentMeals.length >= 20) {
      return new Response(
        JSON.stringify({ error: 'Daily limit of 20 meal analysis calls reached.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. GET SIGNED DOWNLOAD URL FOR THE IMAGE
    const imageUrl = await getDownloadUrl(image_path);
    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: 'Failed to retrieve image download URL.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const mimeType = image_path.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const systemPrompt = `Identify all food items in this meal and estimate their portion size, weight in grams, calories, protein, carbohydrates, fat, fiber, and relevant micronutrients.
Return ONLY a minified, single-line raw JSON object matching this schema. Do not use any indentation, spaces, newlines, or code blocks like \`\`\`json. Output must start with { and end with }.
Ensure all keys are fully quoted and correct JSON syntax is maintained (e.g. "fat": 22).
Schema:
{
  "meal_name": "string",
  "meal_type": "Breakfast" | "Lunch" | "Dinner" | "Snack",
  "total_calories": number,
  "total_protein": number,
  "total_carbohydrates": number,
  "total_fat": number,
  "total_fiber": number,
  "confidence_score": number,
  "micronutrients": {
    "sodium_mg": number,
    "potassium_mg": number,
    "vitamin_c_mg": number
  },
  "food_items": [
    {
      "food_name": "string",
      "estimated_quantity": "string",
      "estimated_grams": number,
      "calories": number,
      "protein": number,
      "carbohydrates": number,
      "fat": number,
      "fiber": number
    }
  ]
}`;

    const requiredKeys = ['meal_name', 'meal_type', 'total_calories', 'total_protein', 'total_carbohydrates', 'total_fat', 'total_fiber', 'food_items'];

    const findEndOfJsonObject = (str: string, startIndex: number): number => {
      let openBraces = 0;
      let inString = false;
      let escaped = false;
      
      for (let i = startIndex; i < str.length; i++) {
        const char = str[i];
        
        if (escaped) {
          escaped = false;
          continue;
        }
        
        if (char === '\\') {
          escaped = true;
          continue;
        }
        
        if (char === '"') {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '{') {
            openBraces++;
          } else if (char === '}') {
            openBraces--;
            if (openBraces === 0) {
              return i;
            }
          }
        }
      }
      return -1;
    };

    const extractJson = (raw: string): any => {
      const firstCurly = raw.indexOf('{');
      if (firstCurly === -1) {
        throw new Error(`Could not find opening curly brace '{' in response: ${raw}`);
      }
      
      const lastCurly = findEndOfJsonObject(raw, firstCurly);
      if (lastCurly === -1) {
        throw new Error(`Could not find matching closing curly brace '}' in response: ${raw}`);
      }
      
      const cleaned = raw.substring(firstCurly, lastCurly + 1).trim();
      try {
        return JSON.parse(cleaned);
      } catch (firstErr: any) {
        console.warn(`Initial JSON parse failed, attempting auto-repair: ${firstErr.message}`);
        try {
          // Fix missing closing quote and colon: "fat:22 -> "fat":22
          const repaired = cleaned.replace(/"([a-zA-Z0-9_]+):([0-9.-]+)/g, '"$1":$2');
          return JSON.parse(repaired);
        } catch (repairErr: any) {
          throw new Error(`Failed to parse and repair JSON. Original error: ${firstErr.message}. Repair error: ${repairErr.message}`);
        }
      }
    };

    const validateParsed = (parsed: any, rawTextForError: string) => {
      for (const key of requiredKeys) {
        if (parsed[key] === undefined) {
          throw new Error(`AI JSON output missing required field: ${key}. Raw response: ${rawTextForError}`);
        }
      }
    };

    const fetchWithRetry = async (url: string, options: any, maxRetries = 2) => {
      let delay = 1000;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          const res = await fetch(url, options);
          if (res.ok) return res;
          const errText = await res.text();
          throw new Error(`API returned status ${res.status}: ${errText}`);
        } catch (err: any) {
          if (attempt > maxRetries) {
            throw err;
          }
          console.warn(`Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 3; // Exponential backoff (1s, 3s)
        }
      }
      throw new Error('Max retries reached');
    };

    // 6. CALL AI PROVIDER: try OpenRouter's multi-model routing first, fall back to Gemini
    const openRouterKey = Deno.env.get('OPENROUTER_API_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');

    let parsedResult: any = null;
    let providerUsed = '';

    if (openRouterKey) {
      try {
        const orPayload = {
          model: 'google/gemma-4-26b-a4b-it:free',
          models: ['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'],
          max_tokens: 1200,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: systemPrompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
        };

        // Only 1 retry here — OpenRouter already tries each model in the list internally.
        // Wrap in a native AbortSignal.timeout of 20 seconds to allow free models enough time under load.
        let orResponse;
        try {
          orResponse = await fetchWithRetry(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openRouterKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(orPayload),
              signal: AbortSignal.timeout(27000),
            },
            1
          );
        } catch (orErr: any) {
          throw new Error(`OpenRouter query failed or timed out: ${orErr.message}`);
        }

        const orData = await orResponse.json();
        const orText = orData.choices?.[0]?.message?.content;
        if (!orText) throw new Error(`OpenRouter returned empty response: ${JSON.stringify(orData)}`);

        const parsed = extractJson(orText);
        validateParsed(parsed, orText);

        parsedResult = parsed;
        providerUsed = orData.model ? `openrouter:${orData.model}` : 'openrouter';
        console.log(`analyze-meal served by ${providerUsed}`);
      } catch (orErr: any) {
        return new Response(
          JSON.stringify({ error: `OpenRouter failed: ${orErr.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } else {
      return new Response(
        JSON.stringify({ error: 'OPENROUTER_API_KEY secret is not configured.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 7. SAVE TO DATABASE (meals + meal_food_items) — unchanged from original
    const insertMealRes = await fetch(`${baseUrl}/api/database/records/meals`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify([
        {
          user_id: userId,
          image_path,
          meal_type: parsedResult.meal_type,
          meal_name: parsedResult.meal_name,
          total_calories: parsedResult.total_calories,
          total_protein: parsedResult.total_protein,
          total_carbohydrates: parsedResult.total_carbohydrates,
          total_fat: parsedResult.total_fat,
          total_fiber: parsedResult.total_fiber,
          micronutrients: parsedResult.micronutrients || {},
          confidence_score: parsedResult.confidence_score || 1.0,
          idempotency_key: idempotency_key,
        },
      ]),
    });

    if (!insertMealRes.ok) {
      const errText = await insertMealRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to save meal record: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const newMeals = await insertMealRes.json();
    if (!newMeals || newMeals.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Database insert returned empty array for meal.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const mealId = newMeals[0].id;
    const itemsToInsert = parsedResult.food_items.map((item: any) => {
      const parseNum = (val: any, fallback = 0): number | null => {
        if (val === undefined || val === null) return fallback;
        const num = Number(val);
        return isNaN(num) ? fallback : num;
      };

      return {
        meal_id: mealId,
        food_name: item.food_name || item.name || 'Unknown Food',
        estimated_quantity: item.estimated_quantity || item.quantity || null,
        estimated_grams: item.estimated_grams !== undefined ? parseNum(item.estimated_grams, null) : parseNum(item.estimated_weight, null),
        calories: parseNum(item.calories, 0),
        protein: parseNum(item.protein, 0),
        carbohydrates: parseNum(item.carbohydrates, 0),
        fat: parseNum(item.fat, 0),
        fiber: parseNum(item.fiber, 0),
      };
    });

    const insertItemsRes = await fetch(`${baseUrl}/api/database/records/meal_food_items`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(itemsToInsert),
    });

    if (!insertItemsRes.ok) {
      await fetch(`${baseUrl}/api/database/records/meals?id=eq.${mealId}`, {
        method: 'DELETE',
        headers: { 'Authorization': authHeader },
      });
      const errText = await insertItemsRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to save meal food items: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // imageUrl is already defined above

    return new Response(
      JSON.stringify({
        meal: newMeals[0],
        food_items: itemsToInsert,
        imageUrl,
        is_duplicate: false,
        provider_used: providerUsed,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || 'An unexpected error occurred.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}