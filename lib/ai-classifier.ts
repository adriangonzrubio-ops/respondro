export async function classifyEmail(subject: string, body: string) {
  const prompt = `
    You are an e-commerce customer service expert. Categorize this email into EXACTLY one of these categories:
    - tracking_update (Asking where their order is)
    - refund_request (Wants money back)
    - cancellation (Wants to stop an order)
    - product_question (Details about items)
    - customer_complaint (Faulty product, bad experience)
    - marketing (Newsletters, ads)
    - spam (Junk)
    - other (General inquiries)

    Email Subject: ${subject}
    Email Body: ${body.substring(0, 1000)}

    Respond only in JSON format: { "category": "category_name", "priority": "high/medium/low", "reason": "brief explanation" }
  `;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307", // Fast and cheap for classification
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  // Clean up the text response into actual JSON
  return JSON.parse(data.content[0].text);
}