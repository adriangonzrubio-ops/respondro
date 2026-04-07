import { NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

// 📥 GET: Pulls everything the app needs to see (SaaS-Ready)
export async function GET() {
  try {
    // 1. Get Branding (Signature/Logo) from settings table
    const { data: settings } = await supabase.from('settings').select('*').single();
    
    // 2. Get Shopify Connection from the 'stores' table (found in your screenshot)
    const { data: storeData } = await supabase.from('stores').select('*').single();

    // 3. Get Email Connection from the 'user_connections' table
    const { data: connections } = await supabase.from('user_connections').select('*');
    const emailConn = connections?.find(c => c.imap_host || c.gmail_access_token);

    // 4. Send the "Truth" to the frontend
    const responseData = {
      rulebook: settings?.rulebook || storeData?.rulebook || '',
      signature: settings?.signature || '',
      logo_url: settings?.logo_url || '',
      has_shopify: !!storeData?.shopify_token, 
      shop_url: storeData?.shopify_url || '',
      has_email: !!emailConn,
      connected_email: emailConn?.email || '',
      imap_host: emailConn?.imap_host || ''
    };

    console.log("📡 API returning truth:", responseData);
    return NextResponse.json(responseData);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 📤 POST: Saves branding data
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { rulebook, logo_url, logo_width, signature } = body;

    const { data, error } = await supabase
      .from('settings')
      .upsert({ id: 1, rulebook, logo_url, logo_width, signature })
      .select();

    if (error) throw error;
    return NextResponse.json({ message: 'Settings saved!', data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}