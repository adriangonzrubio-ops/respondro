import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function classifyAndDraft(subject: string, body: string, rulebook: string, storeName: string, shopifyData: any) {
    try {
        console.log(`🤖 [AI] Classifying email for ${storeName}. Context: ${shopifyData ? 'YES' : 'NO'}`);

        const response = await anthropic.messages.create({
            model: 'claude-3-sonnet-20240229', // Using Claude 3 Sonnet for proactive drafting
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `
                You are the Proactive Lead Support Agent for ${storeName}. Your mission is to automate responses wherever possible.

                ### INPUTS:
                RULEBOOK: ${rulebook}
                CUSTOMER EMAIL: ${body}
                SHOPIFY DATA: ${JSON.stringify(shopifyData)}

                ### TASK:
                1. **Categorize and Prioritize:** Categorize the inquiry (e.g., Shipping, Refund) and set priority.
                2. **Decide Automation:** Based 100% on the RULEBOOK and the provided SHOPIFY DATA, can you automate this response completely with high confidence?
                   - If yes, set path to "AUTOMATE". This means your draft will be sent without any human review.
                   - If no (due to lack of context or ambiguous rules), set path to "REVIEW".
                3. **Write a Professional Draft:** Write a polite, complete, and branded response. Sign off as "${storeName} Support Team".

                ### CRITICAL: PROACTIVE POLICY
                - If the customer asks "Where is my order?" and the Shopify data shows "Fulfillment Status: Fulfilled", you MUST automate the response. Give them the order details.

                ### RETURN JSON ONLY:
                {
                    "path": "AUTOMATE" | "REVIEW",
                    "category": "string",
                    "priority": "Low" | "Medium" | "High",
                    "draft": "string",
                    "reason": "string"
                }`
            }],
        });

        // Parse the response, handling any non-text or extra tokens Claude might send
        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return JSON.parse(content);
    } catch (error: any) {
        console.error("❌ [AI ERROR]:", error.message || error);
        return { path: "REVIEW", category: "General Inquiry", priority: "Medium", draft: "I'll look into that for you.", reason: "Error" };
    }
}