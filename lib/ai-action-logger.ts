import { supabaseAdmin } from './supabase';

export type AiActionType = 
  | 'draft_generated'
  | 'auto_reply_sent'
  | 'refund_issued'
  | 'order_cancelled'
  | 'address_changed'
  | 'escalated_to_human';

interface LogActionParams {
    storeId: string;
    messageId?: string;
    actionType: AiActionType;
    summary: string;
    details?: Record<string, any>;
    customerEmail?: string;
    customerName?: string;
    subject?: string;
    confidence?: number;
    aiModel?: string;
}

/**
 * Log an AI action for the AI Activity feed.
 * Fails silently to never block the main action flow.
 */
export async function logAiAction(params: LogActionParams): Promise<void> {
    try {
        const { error } = await supabaseAdmin.from('ai_actions').insert({
            store_id: params.storeId,
            message_id: params.messageId || null,
            action_type: params.actionType,
            summary: params.summary,
            details: params.details || null,
            customer_email: params.customerEmail || null,
            customer_name: params.customerName || null,
            subject: params.subject || null,
            confidence: params.confidence ?? null,
            ai_model: params.aiModel || null
        });

        if (error) {
            console.error('❌ Failed to log AI action:', error.message);
            // Don't throw — logging failure shouldn't break the main flow
        }
    } catch (err: any) {
        console.error('❌ logAiAction exception:', err.message);
    }
}

/**
 * Helper to extract email from a "Name <email@domain.com>" format
 */
export function extractEmail(sender: string | null | undefined): string | undefined {
    if (!sender) return undefined;
    const match = sender.match(/<([^>]+)>/);
    if (match) return match[1].trim();
    if (sender.includes('@')) return sender.trim();
    return undefined;
}

/**
 * Helper to extract name from a "Name <email@domain.com>" format
 */
export function extractName(sender: string | null | undefined): string | undefined {
    if (!sender) return undefined;
    const beforeBracket = sender.split('<')[0].trim().replace(/"/g, '');
    if (beforeBracket && beforeBracket !== sender) return beforeBracket;
    return undefined;
}