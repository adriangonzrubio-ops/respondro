import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function POST(req: Request) {
    try {
        // 1. Safety Check for API Key
        if (!process.env.ANTHROPIC_API_KEY) {
            console.error("❌ MISSING ANTHROPIC_API_KEY");
            return NextResponse.json({ error: "API Key not configured on server" }, { status: 500 });
        }

        const { agentType, userMessage, currentRulebook } = await req.json();

        const systemPrompt = `
        You are a system that updates a support agent's rulebook.
        Current Agent: ${agentType}
        Current Rules: ${currentRulebook}
        User Update: ${userMessage}

        Return ONLY a raw JSON object with these keys: "updatedRulebook" and "aiResponse". 
        Do not include any conversational text before or after the JSON.
        `;

        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20240620',
            max_tokens: 1000,
            messages: [{ role: 'user', content: systemPrompt }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        console.log("🤖 Raw AI Response:", text);

        // 2. Robust JSON Extraction
        try {
            const jsonStart = text.indexOf('{');
            const jsonEnd = text.lastIndexOf('}') + 1;
            const cleanJson = JSON.parse(text.slice(jsonStart, jsonEnd));
            return NextResponse.json(cleanJson);
        } catch (parseError) {
            console.error("❌ JSON Parse Failed:", text);
            return NextResponse.json({ 
                updatedRulebook: currentRulebook + "\n- " + userMessage,
                aiResponse: "I've noted that! (Rulebook updated manually due to formatting)." 
            });
        }

    } catch (error: any) {
        console.error("❌ API Route Crash:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}