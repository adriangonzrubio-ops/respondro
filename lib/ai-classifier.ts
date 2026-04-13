import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

interface ClassificationResult {
  path: 'AUTOMATE' | 'REVIEW' | 'SPAM';
  category: string;
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  draft: string;
  reason: string;
  confidence: number;
}

export async function classifyAndDraft(
  subject: string,
  body: string,
  rulebook: string,
  storeName: string,
  shopifyData: any,
  signature?: string,
  previousCategory?: string | null,
  previousStatus?: string | null
): Promise<ClassificationResult> {
    try {
        // Build context about previous interactions for re-classification
        let escalationContext = '';
        if (previousCategory && previousStatus) {
            escalationContext = `
PREVIOUS TICKET CONTEXT:
- This customer previously had a ticket categorized as: "${previousCategory}" (status: ${previousStatus})
- If their intent has CHANGED or ESCALATED (e.g., went from asking about order status to demanding a refund), you MUST update the category to reflect the NEW intent.
- If the customer is now angrier or more demanding than before, increase priority accordingly.`;
        }

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `You are the Lead Support Agent for ${storeName}.

RULEBOOK:
${rulebook}

CUSTOMER EMAIL SUBJECT: ${subject}
CUSTOMER EMAIL BODY: ${body}

SHOPIFY DATA: ${JSON.stringify(shopifyData)}
${escalationContext}

═══ CATEGORY DEFINITIONS (pick exactly one) ═══

order_status        → Customer asking where their order is, tracking updates, delivery ETA
shipping            → Questions about shipping methods, costs, delivery times, countries
refund_request      → Customer wants money back (partial or full)
cancellation        → Customer wants to cancel their order before it ships
exchange            → Customer wants to swap for a different product/size/color
return              → Customer wants to return an item (not necessarily a refund)
address_change      → Customer needs their shipping address updated
damaged_item        → Item arrived broken, defective, or not as described
missing_item        → Item missing from order, or entire order not received
product_question    → Questions about products, sizing, availability, specs
billing             → Payment issues, double charges, invoice requests
complaint           → General unhappiness about experience (not tied to specific issue above)
thank_you           → Customer expressing gratitude, positive feedback
general             → Anything that doesn't fit above categories
spam                → Marketing emails, newsletters, automated notifications, vendor promos, phishing, not from a real customer

═══ PATH RULES ═══

PATH = "SPAM" when:
- The email is from a marketing service, newsletter, automated system, or promotional sender
- The email is a notification from another SaaS tool (e.g., Shopify notifications, payment processor alerts)
- The email is clearly not from a real customer seeking support
- Phishing, scam, or irrelevant commercial email
→ For spam, set draft to "" (empty), category to "spam", priority to "Low"

PATH = "AUTOMATE" when ALL of these are true:
- You have enough Shopify data to give a complete, specific answer
- The inquiry is standard: order_status, shipping, product_question, thank_you, or address_change (on unfulfilled orders)
- The customer tone is neutral or positive (not angry, not demanding)
- No refund, cancellation, complaint, or issue requiring human judgment
- Your confidence in the answer is 85% or higher
- The draft you write is a COMPLETE reply that fully resolves the customer's question

PATH = "REVIEW" when ANY of these are true:
- Category is refund_request, cancellation, complaint, damaged_item, missing_item, billing, or exchange
- Customer is angry, upset, frustrated, or threatening
- You don't have enough data to answer confidently (no Shopify match, unclear request)
- The email mentions legal action, fraud, chargebacks, or social media complaints
- The request requires judgment not covered by the rulebook
- Your confidence is below 85%
- The customer's intent has ESCALATED from a previous ticket

═══ PRIORITY RULES ═══

Urgent  → Legal threats, chargeback mentions, social media threats, VIP customers, orders over $500
High    → Refund/cancellation requests, damaged items, angry customers, missing orders, escalated follow-ups
Medium  → Standard inquiries with some complexity, exchanges, returns
Low     → Simple questions, thank-you messages, general inquiries, spam

═══ WRITING RULES ═══

- Write in plain text only. NEVER use markdown (no **, __, #, bullet points, or dashes as list items).
- Sound like a real, friendly human support agent — not a chatbot.
- Keep paragraphs short (2-3 sentences max).
- Start with "Hi [first name]," if you can identify their name from the email body or sender.
- Reference specific order numbers, tracking numbers, and product names from Shopify data.
- If the order has tracking, include the tracking number and carrier.
- If the order is fulfilled, say so. If unfulfilled, acknowledge the wait.
- DO NOT write any sign-off or signature. End the email body naturally.
- DO NOT use placeholder text like [Name] or [Order Number] — use real data or omit.
- Match the customer's language if the email is not in English.

═══ OUTPUT ═══

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "path": "AUTOMATE" | "REVIEW" | "SPAM",
  "category": "one_of_the_categories_above",
  "priority": "Low" | "Medium" | "High" | "Urgent",
  "draft": "the complete email reply text (empty string for spam)",
  "reason": "1-2 sentence explanation of why you chose this path and category",
  "confidence": 0-100
}`
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in AI response');
        
        const parsed: ClassificationResult = JSON.parse(jsonMatch[0]);

        // Strip any markdown from the draft
        if (parsed.draft) {
            parsed.draft = parsed.draft
                .replace(/\*\*/g, '')
                .replace(/__/g, '')
                .replace(/^#+\s/gm, '')
                .replace(/^[-*]\s/gm, '');
        }

        // Append signature for non-spam
        if (signature && parsed.draft && parsed.path !== 'SPAM') {
            parsed.draft = parsed.draft.trim() + '\n\n' + signature;
        }

        // Safety check: if confidence is low but path is AUTOMATE, downgrade to REVIEW
        if (parsed.path === 'AUTOMATE' && (parsed.confidence || 0) < 85) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ' [Downgraded from AUTOMATE: confidence below 85%]';
        }

        // Safety check: dangerous categories should never be auto-sent
        const reviewOnlyCategories = ['refund_request', 'cancellation', 'complaint', 'damaged_item', 'missing_item', 'billing', 'exchange'];
        if (parsed.path === 'AUTOMATE' && reviewOnlyCategories.includes(parsed.category)) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ` [Downgraded from AUTOMATE: ${parsed.category} requires human review]`;
        }

        return parsed;

    } catch (error: any) {
        console.error('❌ AI Classifier error:', error.message);
        
        // Build a smarter fallback
        const customerName = body.match(/(?:^|\n)\s*([A-Z][a-z]+ ?[A-Z]?[a-z]*)\s*$/m)?.[1] || '';
        const greeting = customerName ? `Hi ${customerName.split(' ')[0]},` : 'Hi,';
        const hasOrder = shopifyData && JSON.stringify(shopifyData).length > 10;
        
        let fallbackDraft: string;
        if (hasOrder) {
            fallbackDraft = `${greeting}\n\nThank you for contacting us. I can see your order details and am looking into this for you. I will follow up shortly with a full update.`;
        } else {
            fallbackDraft = `${greeting}\n\nThank you for reaching out. I am looking into your inquiry and will get back to you shortly with more details.`;
        }
        if (signature) fallbackDraft += '\n\n' + signature;
        
        return {
            path: 'REVIEW',
            category: 'general',
            priority: 'Medium',
            draft: fallbackDraft,
            reason: `AI error — fallback used: ${error.message}`,
            confidence: 0
        };
    }
}