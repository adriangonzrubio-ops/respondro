import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { messageId } = await req.json();

    // 1. Get the message
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (!message) throw new Error('Message not found');

    // 2. Get settings
    let settings = null;
    let storeName = 'Our Store';

    if (message.store_id) {
      const { data: s } = await supabase
        .from('settings')
        .select('*')
        .eq('store_id', message.store_id)
        .single();
      settings = s;

      const { data: store } = await supabase
        .from('stores')
        .select('store_name')
        .eq('id', message.store_id)
        .single();
      storeName = store?.store_name || settings?.store_name || 'Our Store';
    }

    // Fallback
    if (!settings) {
      const { data: firstStore } = await supabase
        .from('stores')
        .select('*')
        .limit(1)
        .single();

      if (firstStore) {
        storeName = firstStore.store_name || 'Our Store';
        const { data: s } = await supabase
          .from('settings')
          .select('*')
          .eq('store_id', firstStore.id)
          .single();
        settings = s;
        if (settings?.store_name) storeName = settings.store_name;

        await supabase
          .from('messages')
          .update({ store_id: firstStore.id })
          .eq('id', messageId);
      }
    }

    let rulebook = settings?.rulebook || 'Be helpful, professional and empathetic.';
    
    // Fetch agent rulebooks and policies
    const storeId = message.store_id || settings?.store_id;
    if (storeId) {
      const { data: agents } = await supabase.from('support_agents').select('agent_type, rulebook, is_enabled').eq('store_id', storeId);
      if (agents && agents.length > 0) {
        const agentRules = agents.filter(a => a.is_enabled && a.rulebook).map(a => `[${a.agent_type.toUpperCase()} AGENT]:\n${a.rulebook}`).join('\n\n');
        if (agentRules) rulebook += '\n\n' + agentRules;
      }
      const { data: policies } = await supabase.from('store_policies').select('policy_type, policy_content').eq('store_id', storeId);
      if (policies && policies.length > 0) {
        const policyText = policies.filter(p => p.policy_content).map(p => `[${p.policy_type.replace(/_/g, ' ').toUpperCase()}]:\n${p.policy_content.substring(0, 3000)}`).join('\n\n');
        if (policyText) rulebook += '\n\nSTORE POLICIES:\n' + policyText;
      }
    }

    // 3. Generate with Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are a support agent for ${storeName}. Write a reply to this customer email.

RULEBOOK: ${rulebook}

CUSTOMER EMAIL: ${message.body_text}

SHOPIFY DATA: ${JSON.stringify(message.shopify_data || {})}

CRITICAL RULES:
1. Output ONLY the email text you would send to the customer
2. NEVER include your thinking, analysis, situation assessment, or internal reasoning
3. NEVER start with "Looking at", "Based on", "Let me check", "I can see that"
4. Start directly with "Hi [first name]," then address their question
5. Be specific using Shopify data (order numbers, tracking, products)
6. Follow the rulebook exactly
7. Write in plain text, no markdown
8. Short paragraphs, friendly human tone
9. DO NOT write any sign-off or signature
10. No placeholders like [Name] — use real data or omit
11. Match the customer's language if not English

Output ONLY the email body text. Nothing else.`
      }],
    });

    const rawContent = response.content[0].type === 'text' ? response.content[0].text : '';
    let draft = rawContent.replace(/^["']|["']$/g, '').trim();
    
    // Strip markdown
    draft = draft.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#+\s/gm, '').replace(/^[-*]\s/gm, '');
    
    // Strip any "thinking" that leaked into the output
    let lines = draft.split('\n');
    let emailStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.match(/^(Hi|Hello|Hey|Dear|Good morning|Good afternoon|Good evening|Thank you for|Thanks for)/i)) {
            emailStart = i;
            break;
        }
        if (line.match(/^(Looking at|Based on|Let me|I can see|The order|The customer|This qualifies|This is a|No prior|Days since|That's \d|Order #?\d|---)/i) || line === '') {
            emailStart = i + 1;
        }
    }
    if (emailStart > 0 && emailStart < lines.length) {
        draft = lines.slice(emailStart).join('\n').trim();
    }

    // Append signature
    const signature = settings?.signature || '';
    if (signature) {
      draft = draft + '\n\n' + signature;
    }

    // 4. Save draft to DB
    await supabase
      .from('messages')
      .update({ ai_draft: draft, status: 'needs_review' })
      .eq('id', messageId);

    return NextResponse.json({ draft });

  } catch (error: any) {
    console.error('❌ Draft Failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}