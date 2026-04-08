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
                    
                    STORE RULEBOOK:
                    ${rulebook}

                    CUSTOMER INQUIRY:
                    Subject: ${subject}
                    Message: ${body}

                    SHOPIFY CONTEXT:
                    ${JSON.stringify(shopifyData, null, 2)}

                    TASK:
                    1. Categorize the email (Shipping, Refund, General, etc).
                    2. Determine Priority (Low, Medium, High).
                    3. DECIDE THE PATH:
                       - Set path to "AUTOMATE" ONLY if the rulebook gives a clear answer AND the Shopify data confirms it (e.g., giving a tracking link).
                       - Set path to "REVIEW" if it requires human empathy, a complex decision, or a refund.
                    4. DRAFT THE RESPONSE:
                       - No Markdown (** or ##).
                       - Sign off as "${storeName} Support Team".

                    Return ONLY a JSON object:
                    {
                        "path": "AUTOMATE" | "REVIEW",
                        "category": "string",
                        "priority": "string",
                        "draft": "string",
                        "reason": "Briefly explain why you chose this path"
                    }
                `
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return JSON.parse(content);
    } catch (error) {
        console.error("AI Classification Error:", error);
        return {
            path: "REVIEW",
            category: "General Inquiry",
            priority: "Medium",
            draft: "I'll look into this for you immediately.",
            reason: "AI failed to process, defaulting to manual review."
        };
    }
}