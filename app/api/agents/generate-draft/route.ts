import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  try {
    const { messageId } = await req.json();

    const { data: message } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (!message) throw new Error('Message not found');

    let storeId = message.store_id;
    let storeName = 'Our Store';
    let settings: any = null;

    if (storeId) {
      const { data: s } = await supabaseAdmin.from('settings').select('*').eq('store_id', storeId).single();
      settings = s;

      const { data: store } = await supabaseAdmin.from('stores').select('store_name').eq('id', storeId).single();
      storeName = store?.store_name || settings?.store_name || 'Our Store';
    }

    if (!settings && !storeId) {
      const { data: firstStore } = await supabaseAdmin.from('stores').select('*').limit(1).single();
      if (firstStore) {
        storeId = firstStore.id;
        storeName = firstStore.store_name || 'Our Store';
        const { data: s } = await supabaseAdmin.from('settings').select('*').eq('store_id', firstStore.id).single();
        settings = s;
        if (settings?.store_name) storeName = settings.store_name;

        await supabaseAdmin.from('messages').update({ store_id: firstStore.id }).eq('id', messageId);
      }
    }

    // ─── TONE OF VOICE TEMPLATES ──────────────────────────
    const TONE_TEMPLATES: Record<string, string> = {
      professional: "Use a polished, formal tone. Write in complete sentences with proper grammar. Avoid contractions, emojis, and casual language. Be courteous and measured.",
      friendly: "Use a warm, conversational tone. Contractions like 'I'm' and 'we've' are welcome. Occasional emojis are fine when they fit naturally (maximum 1-2 per email). Sound approachable and human.",
      warm: "Use an enthusiastic, genuinely caring tone. Show real excitement about helping the customer. Use natural exclamation points where appropriate. Make the customer feel valued.",
      caring: "Use a calm, empathetic tone. ALWAYS acknowledge the customer's feelings first before jumping to solutions. Use phrases like 'I completely understand' and 'I'm so sorry to hear that.' Be patient and reassuring.",
      playful: "Use a casual, upbeat tone with personality. Emojis are welcome and encouraged where they fit naturally (2-4 per email). Short, punchy sentences. Write like you're texting a friend — but still professional.",
      luxury: "Use a refined, confident tone. Keep sentences short and deliberate. Sophisticated vocabulary without pretension. Minimal emojis. Every word should feel chosen on purpose."
    };
    // ─────────────────────────────────────────────────────

    let rulebook = settings?.rulebook || 'Be helpful, professional and empathetic.';
    let toneGuidance = TONE_TEMPLATES.friendly; // default

    if (storeId) {
      const { data: agents } = await supabaseAdmin.from('support_agents').select('agent_type, rulebook, is_enabled, tone_preset, custom_tone_description').eq('store_id', storeId);
      if (agents && agents.length > 0) {
        const agentRules = agents.filter(a => a.is_enabled && a.rulebook).map(a => `[${a.agent_type.toUpperCase()} AGENT]:\n${a.rulebook}`).join('\n\n');
        if (agentRules) rulebook += '\n\n' + agentRules;

        // Determine tone (prefer customer_service agent, fallback to any enabled agent)
        const toneAgent = agents.find(a => a.agent_type === 'customer_service' && a.is_enabled)
          || agents.find(a => a.is_enabled);

        if (toneAgent?.tone_preset === 'custom' && toneAgent.custom_tone_description) {
          toneGuidance = toneAgent.custom_tone_description;
        } else if (toneAgent?.tone_preset && TONE_TEMPLATES[toneAgent.tone_preset]) {
          toneGuidance = TONE_TEMPLATES[toneAgent.tone_preset];
        }
      }
      const { data: policies } = await supabaseAdmin.from('store_policies').select('policy_type, policy_content').eq('store_id', storeId);
      if (policies && policies.length > 0) {
        const policyText = policies.filter(p => p.policy_content).map(p => `[${p.policy_type.replace(/_/g, ' ').toUpperCase()}]:\n${p.policy_content.substring(0, 3000)}`).join('\n\n');
        if (policyText) rulebook += '\n\nSTORE POLICIES:\n' + policyText;
      }
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are a support agent for ${storeName}. Write a reply to this customer email.

TONE OF VOICE: ${toneGuidance}

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

    draft = draft.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#+\s/gm, '').replace(/^[-*]\s/gm, '');

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

    const signature = settings?.signature || '';
    if (signature) {
      draft = draft + '\n\n' + signature;
    }

    await supabaseAdmin.from('messages').update({ ai_draft: draft, status: 'needs_review' }).eq('id', messageId);

    // Log AI action (fails silently, never blocks flow)
    if (storeId) {
      try {
        const { logAiAction, extractEmail, extractName } = await import('@/lib/ai-action-logger');
        await logAiAction({
          storeId,
          messageId,
          actionType: 'draft_generated',
          summary: `Drafted reply for ${extractName(message.sender) || 'customer'}`,
          customerEmail: extractEmail(message.sender),
          customerName: extractName(message.sender),
          subject: message.subject,
          aiModel: 'claude-sonnet-4-6',
          details: { trigger: 'initial_draft' }
        });
      } catch (logErr) {
        console.error('Logging error (non-blocking):', logErr);
      }
    }

    return NextResponse.json({ draft });

  } catch (error: any) {
    console.error('❌ Draft Failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}