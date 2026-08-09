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
    const { message } = body;

    // Minimal input validation for MVP
    if (!message || message.trim() === '') {
      return new Response(
        JSON.stringify({ error: 'Missing required field: message' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (message.length > 2000) {
      return new Response(
        JSON.stringify({ error: 'Message exceeds maximum length of 2000 characters.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. COACH CONTEXT MINIMIZATION
    // Query last 7 days of meals
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fetchMealsRes = await fetch(
      `${baseUrl}/api/database/records/meals?user_id=eq.${userId}&created_at=gte.${sevenDaysAgo}`,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
        },
      }
    );

    if (!fetchMealsRes.ok) {
      const errText = await fetchMealsRes.text();
      return new Response(
        JSON.stringify({ error: `Database meals fetch error: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pastMeals = await fetchMealsRes.json();

    // Compute compact stats summary
    let totalCals = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;
    let totalFiber = 0;
    const mealTypes: Record<string, number> = {};

    pastMeals?.forEach((m: any) => {
      totalCals += Number(m.total_calories || 0);
      totalProtein += Number(m.total_protein || 0);
      totalCarbs += Number(m.total_carbohydrates || 0);
      totalFat += Number(m.total_fat || 0);
      totalFiber += Number(m.total_fiber || 0);
      if (m.meal_type) {
        mealTypes[m.meal_type] = (mealTypes[m.meal_type] || 0) + 1;
      }
    });

    const avgCals = pastMeals?.length ? Math.round(totalCals / 7) : 0;
    const avgProtein = pastMeals?.length ? Math.round(totalProtein / 7) : 0;
    const avgCarbs = pastMeals?.length ? Math.round(totalCarbs / 7) : 0;
    const avgFat = pastMeals?.length ? Math.round(totalFat / 7) : 0;
    const avgFiber = pastMeals?.length ? Math.round(totalFiber / 7) : 0;

    let commonType = 'None';
    let maxCount = 0;
    Object.entries(mealTypes).forEach(([type, count]) => {
      if (count > maxCount) {
        maxCount = count;
        commonType = type;
      }
    });

    const summaryContext = `User's last 7 days stats: Avg Daily Calories: ${avgCals} kcal, Avg Daily Protein: ${avgProtein}g, Avg Daily Carbs: ${avgCarbs}g, Avg Daily Fat: ${avgFat}g, Avg Daily Fiber: ${avgFiber}g. Most common meal type: ${commonType}. Total logged meals in last 7 days: ${pastMeals?.length || 0}.`;

    // Query last 4-6 conversation turns from coach_messages (to minimize tokens)
    const fetchMessagesRes = await fetch(
      `${baseUrl}/api/database/records/coach_messages?user_id=eq.${userId}&order=created_at.desc&limit=6`,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
        },
      }
    );

    if (!fetchMessagesRes.ok) {
      const errText = await fetchMessagesRes.text();
      return new Response(
        JSON.stringify({ error: `Database messages fetch error: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const recentMessages = await fetchMessagesRes.json();
    const history = recentMessages ? [...recentMessages].reverse() : [];

    // 3. CALL GEMINI API (with retries and verified models)
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

    const systemInstruction = `You are "Aahar Coach," an empathetic, expert nutrition and fitness coach. Guide the user based on their last 7 days calorie/macro summary and chat history. Keep answers concise, direct, motivational, and actionable (maximum 2-3 paragraphs). Don't give generic medical advice.`;

    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: `System instruction context:\n${systemInstruction}\n\nUser Macro Summary:\n${summaryContext}`,
          },
        ],
      },
      ...history.map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      {
        role: 'user',
        parts: [{ text: message }],
      },
    ];

    const geminiPayload = { contents };

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
    const assistantText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!assistantText) {
      return new Response(
        JSON.stringify({ error: `Gemini returned empty response: ${JSON.stringify(responseData)}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. SAVE EXCHANGE TO DATABASE
    await fetch(`${baseUrl}/api/database/records/coach_messages`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          user_id: userId,
          role: 'user',
          content: message,
        },
      ]),
    });

    const insertReplyRes = await fetch(`${baseUrl}/api/database/records/coach_messages`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          user_id: userId,
          role: 'assistant',
          content: assistantText,
        },
      ]),
    });

    if (!insertReplyRes.ok) {
      const errText = await insertReplyRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to save reply message: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ text: assistantText }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || 'An unexpected error occurred.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
