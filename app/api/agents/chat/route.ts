import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function POST(req: Request) {
    try {
        const { agentType, userMessage, currentRulebook } = await req.json();

        const systemPrompt = `Update the rulebook for a ${agentType} support agent.
        
        CURRENT RULEBOOK:
        ${currentRulebook}

        USER INSTRUCTION:
        "${userMessage}"

        Return ONLY a JSON object with:
        "updatedRulebook": (the full text),
        "aiResponse": (short confirmation).
        DO NOT include any other text.`;

        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20240620',
            max_tokens: 1500,
            messages: [{ role: 'user', content: systemPrompt }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        
        // Use a regex to find the JSON block if Claude adds extra chatter
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const cleanJson = jsonMatch ? JSON.parse(jsonMatch[0]) : { error: "Invalid AI response" };

        return NextResponse.json(cleanJson);
    } catch (error) {
        console.error("Agent Chat Error:", error);
        return NextResponse.json({ error: "Failed to update agent knowledge" }, { status: 500 });
    }
}