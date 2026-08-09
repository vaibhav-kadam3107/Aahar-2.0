export default async function (req: Request): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Handle CORS pre-flight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only allow POST requests as requested
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method Not Allowed. Please send a POST request.' }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    // 1. Read GEMINI_API_KEY from secrets
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'GEMINI_API_KEY secret is not configured in the InsForge project.' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Helper to call Gemini API for a specific model
    const callGemini = async (modelName: string) => {
      return await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: 'What is the latest news in India? Summarize it in one paragraph.',
                  },
                ],
              },
            ],
          }),
        }
      );
    };

    // 2. Try calling the Primary model (gemini-3.6-flash)
    let modelUsed = 'gemini-3.6-flash';
    let response = await callGemini(modelUsed);
    let primaryErrorDetails = '';

    if (!response.ok) {
      primaryErrorDetails = await response.text();
      console.warn(`Primary model (${modelUsed}) failed: ${primaryErrorDetails}. Trying fallback...`);
      
      // 3. Fallback to gemini-3.5-flash
      modelUsed = 'gemini-3.5-flash';
      response = await callGemini(modelUsed);

      if (!response.ok) {
        const fallbackErrorDetails = await response.text();
        return new Response(
          JSON.stringify({
            error: `Both models failed. Primary (gemini-3.6-flash) error: ${primaryErrorDetails}. Fallback (gemini-3.5-flash) error: ${fallbackErrorDetails}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // 4. Extract text from the successful Gemini response
    const responseData = await response.json();
    const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return new Response(
        JSON.stringify({
          error: `Failed to extract text from Gemini response using model ${modelUsed}. Response: ${JSON.stringify(responseData)}`,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 5. Return JSON response
    return new Response(
      JSON.stringify({ summary: text, model: modelUsed }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || 'An unexpected error occurred.' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}
