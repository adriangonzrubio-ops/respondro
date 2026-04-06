import { NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

// 📥 GET: Pulls settings from the DB when the page loads
export async function GET() {
  try {
    // Replace 'shops' and the ID logic with however you identify your user/store
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 📤 POST: Saves everything (Rulebook, Logo, Signature) in one go
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { rulebook, logo_url, logo_width, signature } = body;

    const { data, error } = await supabase
      .from('settings')
      .upsert({ 
        id: 1, // Use a real ID or shop name here
        rulebook, 
        logo_url, 
        logo_width, 
        signature 
      })
      .select();

    if (error) throw error;
    return NextResponse.json({ message: 'Settings saved!', data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}