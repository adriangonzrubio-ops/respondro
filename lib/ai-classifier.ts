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
                You are the Lead Automation Agent for ${storeName}.
                
                ### MISSION:
                Identify if the email is a genuine CUSTOMER support request or just SPAM/MARKETING.

                ### INPUTS:
                RULEBOOK: ${rulebook}
                CUSTOMER EMAIL: ${body}
                SHOPIFY DATA: ${JSON.stringify(shopifyData)}

                ### TASK:
                1. **Filter:** Is this a marketing email, a newsletter, a "no-reply" notification, or spam?
                   - If yes, set path to "IGNORE".
                2. **Categorize:** If it IS a customer, categorize it (Shipping, Refund, etc).
                3. **Automate:** If the Shopify data gives a clear answer, set path to "AUTOMATE". 
                4. **Review:** Only use "REVIEW" if data is missing.

                Return ONLY JSON:
                {
                    "path": "AUTOMATE" | "REVIEW" | "IGNORE",
                    "category": "string",
                    "priority": "Low" | "Medium" | "High",
                    "draft": "Write a professional response ONLY if not IGNORE",
                    "reason": "string"
                }`
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        return JSON.parse(content);
    } catch (error) {
        return { path: "REVIEW", category: "General", priority: "Medium", draft: "", reason: "Error" };
    }
}