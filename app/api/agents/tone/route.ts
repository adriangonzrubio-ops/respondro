import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const VALID_PRESETS = ['professional', 'friendly', 'warm', 'caring', 'playful', 'luxury', 'custom'];

export async function POST(req: Request) {
    try {
        const { storeId, agentType, tonePreset, customToneDescription } = await req.json();

        // Validation
        if (!storeId || !agentType) {
            return NextResponse.json({ error: 'storeId and agentType required' }, { status: 400 });
        }

        if (!VALID_PRESETS.includes(tonePreset)) {
            return NextResponse.json({ 
                error: `Invalid tone_preset. Must be one of: ${VALID_PRESETS.join(', ')}` 
            }, { status: 400 });
        }

        if (tonePreset === 'custom' && !customToneDescription?.trim()) {
            return NextResponse.json({ 
                error: 'customToneDescription required when tonePreset is "custom"' 
            }, { status: 400 });
        }

        // Check if agent exists
        const { data: existing } = await supabaseAdmin
            .from('support_agents')
            .select('id')
            .eq('store_id', storeId)
            .eq('agent_type', agentType)
            .maybeSingle();

        if (existing) {
            // Update existing agent
            const { error: updateError } = await supabaseAdmin
                .from('support_agents')
                .update({
                    tone_preset: tonePreset,
                    custom_tone_description: tonePreset === 'custom' ? customToneDescription : null
                })
                .eq('id', existing.id);

            if (updateError) {
                console.error('❌ Tone update failed:', updateError.message);
                return NextResponse.json({ error: updateError.message }, { status: 500 });
            }
        } else {
            // Create new agent row with just tone (rulebook stays empty until set)
            const { error: insertError } = await supabaseAdmin
                .from('support_agents')
                .insert({
                    store_id: storeId,
                    agent_type: agentType,
                    rulebook: '',
                    is_enabled: true,
                    tone_preset: tonePreset,
                    custom_tone_description: tonePreset === 'custom' ? customToneDescription : null
                });

            if (insertError) {
                console.error('❌ Tone insert failed:', insertError.message);
                return NextResponse.json({ error: insertError.message }, { status: 500 });
            }
        }

        return NextResponse.json({ success: true, tonePreset });

    } catch (error: any) {
        console.error('❌ Tone API error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const storeId = searchParams.get('storeId');
        const agentType = searchParams.get('agentType');

        if (!storeId || !agentType) {
            return NextResponse.json({ error: 'storeId and agentType required' }, { status: 400 });
        }

        const { data: agent } = await supabaseAdmin
            .from('support_agents')
            .select('tone_preset, custom_tone_description')
            .eq('store_id', storeId)
            .eq('agent_type', agentType)
            .maybeSingle();

        return NextResponse.json({
            tonePreset: agent?.tone_preset || 'friendly',
            customToneDescription: agent?.custom_tone_description || ''
        });

    } catch (error: any) {
        console.error('❌ Tone GET error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}