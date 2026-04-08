import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function POST(req: Request) {
    try {
        const { agentType, userMessage, currentRulebook } = await req.json();

        const systemPrompt = `
        You are a Knowledge Base Architect for a Shopify Support Agent.
        Agent Type: ${agentType}
        
        YOUR TASK:
        1. Take the User's Instruction.
        2. Update the Current Rulebook by adding, removing, or modifying rules based on that instruction.
        3. Maintain a professional, clear, and structured list format.
        4. Keep existing rules that weren't mentioned.

        CURRENT RULEBOOK:
        ${currentRulebook}

        USER INSTRUCTION:
        "${userMessage}"

        RESPONSE FORMAT:
        You must return a JSON object ONLY:
        {
            "updatedRulebook": "The full updated rulebook text here",
            "aiResponse": "A short, friendly confirmation message to the merchant (e.g., 'Got it! I've updated the shipping rules to 3-5 days.')"
        }
        `;

        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20240620',
            max_tokens: 1500,
            messages: [{ role: 'user', content: systemPrompt }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return NextResponse.json(JSON.parse(content));
    } catch (error) {
        console.error("Agent Chat Error:", error);
        return NextResponse.json({ error: "Failed to update agent knowledge" }, { status: 500 });
    }
}