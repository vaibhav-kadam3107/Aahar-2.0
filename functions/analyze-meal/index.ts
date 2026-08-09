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
      headers: {
        'Authorization': authHeader,
      },
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

    // Minimal input validation for MVP
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
        {
          method: 'GET',
          headers: {
            'Authorization': authHeader,
          },
        }
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
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
        },
      }
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
      // Meal already exists, fetch food items and return immediately
      const fetchItemsRes = await fetch(
        `${baseUrl}/api/database/records/meal_food_items?meal_id=eq.${existingMeals[0].id}`,
        {
          method: 'GET',
          headers: {
            'Authorization': authHeader,
          },
        }
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
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
        },
      }
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

    // 4. DOWNLOAD IMAGE FROM STORAGE via Download Strategy (prevents Authorization forwarding to S3)
    const strategyResponse = await fetch(
      `${baseUrl}/api/storage/buckets/meals/download-strategy/objects/${image_path}`,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
        },
      }
    );

    if (!strategyResponse.ok) {
      const errText = await strategyResponse.text();
      return new Response(
        JSON.stringify({ error: `Failed to get download strategy: ${errText}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const strategyData = await strategyResponse.json();
    let downloadUrl = strategyData.url;
    const downloadHeaders: HeadersInit = {};

    if (strategyData.method === 'direct') {
      if (downloadUrl.startsWith('/')) {
        downloadUrl = `${baseUrl}${downloadUrl}`;
      }
      downloadHeaders['Authorization'] = authHeader;
    }

    const downloadRes = await fetch(downloadUrl, {
      method: 'GET',
      headers: downloadHeaders,
    });

    if (!downloadRes.ok) {
      const errText = await downloadRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to download image from storage: ${errText}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const blob = await downloadRes.blob();

    // 5. IMAGE SIZE GUARD
    if (blob.size > 2 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: 'Image exceeds size limit of 2MB.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Convert Blob to base64
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    const len = uint8Array.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64Data = btoa(binary);

    // 6. CALL GEMINI API (with bounded retries and verified models)
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'GEMINI_API_KEY secret is not configured.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const fetchWithRetry = async (url: string, options: any, maxRetries = 2) => {
      let delay = 1000;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          const res = await fetch(url, options);
          if (res.ok) return res;
          const errText = await res.text();
          throw new Error(`Gemini API returned status ${res.status}: ${errText}`);
        } catch (err: any) {
          if (attempt > maxRetries) {
            throw err;
          }
          console.warn(`Gemini attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 3; // Exponential backoff (1s, 3s)
        }
      }
      throw new Error('Max retries reached');
    };

    const systemPrompt = `Identify all food items in this meal and estimate their portion size, weight in grams, calories, protein, carbohydrates, fat, fiber, and relevant micronutrients.
Return ONLY a raw JSON object matching this schema. Do not wrap it in markdown code blocks like \`\`\`json or add any explanation text.
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

    const geminiPayload = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: blob.type || 'image/jpeg',
                data: base64Data,
              },
            },
            {
              text: systemPrompt,
            },
          ],
        },
      ],
    };

    // Call gemini-3.6-flash (current verified active model)
    const geminiResponse = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(geminiPayload),
      }
    );

    const responseData = await geminiResponse.json();
    let text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return new Response(
        JSON.stringify({ error: `Gemini returned empty response: ${JSON.stringify(responseData)}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Strip markdown code block wrapper if present
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsedResult = JSON.parse(text);

    // Validate parsed results strictly
    const requiredKeys = ['meal_name', 'meal_type', 'total_calories', 'total_protein', 'total_carbohydrates', 'total_fat', 'total_fiber', 'food_items'];
    for (const key of requiredKeys) {
      if (parsedResult[key] === undefined) {
        return new Response(
          JSON.stringify({ error: `Gemini JSON output missing required field: ${key}. Raw response: ${text}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // 7. SAVE TO DATABASE (meals + meal_food_items)
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
    const itemsToInsert = parsedResult.food_items.map((item: any) => ({
      meal_id: mealId,
      food_name: item.food_name,
      estimated_quantity: item.estimated_quantity,
      estimated_grams: item.estimated_grams,
      calories: item.calories,
      protein: item.protein,
      carbohydrates: item.carbohydrates,
      fat: item.fat,
      fiber: item.fiber,
    }));

    const insertItemsRes = await fetch(`${baseUrl}/api/database/records/meal_food_items`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(itemsToInsert),
    });

    if (!insertItemsRes.ok) {
      // Clean up the created meal record
      await fetch(`${baseUrl}/api/database/records/meals?id=eq.${mealId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': authHeader,
        },
      });
      const errText = await insertItemsRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to save meal food items: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const imageUrl = await getDownloadUrl(image_path);

    return new Response(
      JSON.stringify({
        meal: newMeals[0],
        food_items: itemsToInsert,
        imageUrl,
        is_duplicate: false,
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
