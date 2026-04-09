import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function classifyAndDraft(subject: string, body: string, rulebook: string, storeName: string, shopifyData: any) {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929', 
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `
                You are the Lead Support Automation for ${storeName}. 
                MANDATE: Automate customer service responses.

                ### CONTEXT:
                RULEBOOK: ${rulebook}
                CUSTOMER EMAIL: ${body}
                SHOPIFY DATA: ${JSON.stringify(shopifyData)}

                ### TASK:
                1. If Shopify Data provides a clear answer (e.g., status is "Fulfilled" or tracking is there), set path to "AUTOMATE".
                2. Write a professional, human response. Sign off as "${storeName} Support Team".

                Return JSON: { "path": "AUTOMATE" | "REVIEW", "category": "string", "priority": "Low" | "Medium" | "High", "draft": "string", "reason": "string" }`
            }],
        });
        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return JSON.parse(content);
    } catch (error) {
        return { path: "REVIEW", category: "General", priority: "Medium", draft: `Hi,\n\nThank you for reaching out. We have received your message and will get back to you as soon as possible.\n\nBest regards,\nCustomer Service Team`, reason: "AI error — fallback used." };
    }
}