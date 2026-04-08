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
                You are the Lead Support Agent for ${storeName}.
                
                RULEBOOK: ${rulebook}
                CUSTOMER EMAIL: ${body}
                SHOPIFY DATA: ${JSON.stringify(shopifyData)}

                TASK:
                1. Categorize (Shipping, Refund, etc).
                2. If the rulebook gives a 100% clear answer based on the Shopify data, set path to "AUTOMATE".
                3. Otherwise, set path to "REVIEW".
                4. Write a professional draft. No markdown (**), no placeholders.
                5. Sign off as "${storeName} Support Team".

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
        return { path: "REVIEW", category: "General", priority: "Medium", draft: "I will look into this.", reason: "Error" };
    }
}