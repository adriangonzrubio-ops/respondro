import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function classifyAndDraft(subject: string, body: string, rulebook: string, storeName: string, shopifyData: any) {
    try {
        // Using the sonnet-4-5 model as required
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `
                You are the Proactive Lead Support Agent for ${storeName}. 
                Your mission is to automate customer service.

                ### INPUT CONTEXT:
                RULEBOOK: ${rulebook}
                CUSTOMER EMAIL: ${body}
                SHOPIFY DATA: ${JSON.stringify(shopifyData)}

                ### YOUR MISSION:
                1. **Categorize:** Identify the intent (e.g., Shipping Inquiry, Return Request).
                2. **Automation Decision:** Compare the email and the Shopify Data against the Rulebook. 
                   - If the data is present and the rule is clear, you MUST set "path" to "AUTOMATE". 
                   - Examples: If they ask for status and you see a tracking number, AUTOMATE. If they want to cancel and the order is unfulfilled, AUTOMATE.
                   - Only set "path" to "REVIEW" if the request is high-risk or context is truly missing.
                3. **Drafting:** Write a final, professional response. No placeholders like [Name]. Use the data provided.

                ### RESPONSE FORMAT (JSON ONLY):
                {
                    "path": "AUTOMATE" | "REVIEW",
                    "category": "string",
                    "priority": "Low" | "Medium" | "High",
                    "draft": "string",
                    "reason": "Explain why you chose to automate or review."
                }`
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return JSON.parse(content);
    } catch (error) {
        console.error("AI Error:", error);
        return { path: "REVIEW", category: "General", priority: "Medium", draft: "Manual review required due to system timeout.", reason: "Model Error" };
    }
}