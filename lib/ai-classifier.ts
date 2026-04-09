import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function classifyAndDraft(subject: string, body: string, rulebook: string, storeName: string, shopifyData: any) {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `
                You are the Proactive Lead Support Agent for ${storeName}.
                
                RULEBOOK: ${rulebook}
                CUSTOMER EMAIL: ${body}
                SHOPIFY DATA: ${JSON.stringify(shopifyData)}

                ### YOUR GOAL:
                If the Shopify Data or the Rulebook provides a clear answer (e.g., tracking info is available, or it's a simple greeting), you MUST set "path" to "AUTOMATE". 
                Only use "REVIEW" if the request is high-risk or truly missing info.

                Return ONLY JSON:
                {
                    "path": "AUTOMATE" | "REVIEW",
                    "category": "string",
                    "priority": "Low" | "Medium" | "High",
                    "draft": "string",
                    "reason": "string"
                }`
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return JSON.parse(content);
    } catch (error) {
        return { path: "REVIEW", category: "General", priority: "Medium", draft: "Manual check required.", reason: "Error" };
    }
}