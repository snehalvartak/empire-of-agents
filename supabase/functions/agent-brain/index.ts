import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { model, messages, max_tokens = 500, temperature = 0.9, response_format } = await req.json();

    if (!model || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: model, messages' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
      const { createClient } = await import('npm:@supabase/supabase-js@2');
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );
      const { data: settings } = await supabase
        .from('settings')
        .select('openrouter_key')
        .eq('id', 'global')
        .maybeSingle();
      apiKey = settings?.openrouter_key ?? undefined;
    }
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'No OpenRouter API key configured. Add one in Settings.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: Record<string, unknown> = { model, messages, max_tokens, temperature };
    // structured output: force the reply to conform to the act schema when asked
    if (response_format) body.response_format = response_format;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://machineplaying.demo',
        'X-Title': 'Machine Playing Demo',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || 'Upstream model request failed' }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request to agent-brain function' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
