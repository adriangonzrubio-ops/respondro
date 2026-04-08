// --- Respondro AI Classifier & Gatekeeper ---

export async function classifyEmail(subject: string, body: string, rulebook: string) {
    const prompt = `
    You are the "Gatekeeper" for a high-end Shopify store. Your goal is to automate 90% of customer service.
    
    TASK: Analyze this email and categorize it into ONE of two paths:
    
    PATH 1: AUTOMATE
    - For "Easy" emails: Tracking updates, shipping times, general store info, or policy questions found in the rulebook.
    - If you have enough info to answer perfectly, choose this path.
    
    PATH 2: REVIEW
    - For "Complex" emails: Refund requests, cancellation requests, complaints about broken/wrong items, or angry customers.
    - These MUST be reviewed by the store owner in the Review Board.
    
    RULEBOOK:
    ${rulebook || "Standard professional store policies apply."}
    
    CUSTOMER EMAIL:
    Subject: ${subject}
    Body: ${body}
    
    Respond ONLY in JSON format:
    {
      "path": "AUTOMATE" or "REVIEW",
      "category": "tracking_update" | "refund_request" | "product_question" | "cancellation" | "other",
      "priority": "high" | "medium" | "low",
      "reason": "Brief explanation why",
      "draft": "Write a complete, professional reply if path is AUTOMATE. Otherwise, leave empty."
    }`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY!,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-5', // Locked in for Respondro
                max_tokens: 1000,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await response.json();
        const result = JSON.parse(data.content[0].text);
        
        return result;
    } catch (error) {
        console.error("Classification Error:", error);
        // Fallback to human review if AI fails
        return { path: "REVIEW", category: "other", priority: "high", reason: "AI error", draft: "" };
    }
}