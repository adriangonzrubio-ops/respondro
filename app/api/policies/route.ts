import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET - Fetch all policies for a store
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const storeId = searchParams.get('store_id');
    
    if (!storeId) {
        return NextResponse.json({ error: 'store_id required' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('store_policies')
        .select('*')
        .eq('store_id', storeId);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ policies: data || [] });
}

// POST - Fetch policy from URL and store it
export async function POST(request: Request) {
    try {
        const { store_id, policy_type, policy_url } = await request.json();

        if (!store_id || !policy_type || !policy_url) {
            return NextResponse.json({ error: 'store_id, policy_type, and policy_url are required' }, { status: 400 });
        }

        // Fetch the policy page content
        const res = await fetch(policy_url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Respondro/1.0)',
                'Accept': 'text/html,application/xhtml+xml'
            }
        });

        if (!res.ok) {
            return NextResponse.json({ error: `Failed to fetch policy page: ${res.status}` }, { status: 400 });
        }

        const html = await res.text();

        // Extract readable text from HTML
        const policyContent = extractTextFromHTML(html);

        if (!policyContent || policyContent.length < 50) {
            return NextResponse.json({ error: 'Could not extract meaningful content from the URL. Please check the link.' }, { status: 400 });
        }

        // Store in Supabase
        const { data, error } = await supabase
            .from('store_policies')
            .upsert({
                store_id,
                policy_type,
                policy_url,
                policy_content: policyContent.substring(0, 50000), // Limit to 50k chars
                updated_at: new Date().toISOString()
            }, { onConflict: 'store_id,policy_type' })
            .select()
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ 
            success: true, 
            policy: data,
            contentLength: policyContent.length 
        });

    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// Simple HTML to text extractor
function extractTextFromHTML(html: string): string {
    // Remove script and style tags and their content
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
    
    // Try to find the main content area
    const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                      text.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                      text.match(/<div[^>]*class="[^"]*policy[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                      text.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    if (mainMatch) {
        text = mainMatch[1];
    }
    
    // Convert common HTML elements to readable text
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '- ');
    
    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');
    
    // Decode HTML entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');
    
    // Clean up whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
    text = text.trim();
    
    return text;
}