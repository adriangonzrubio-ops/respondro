import { NextResponse } from 'next/server';
import { extractText } from 'unpdf';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // 🛠️ THE FIX: Use Uint8Array directly instead of Buffer.from()
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    
    let extractedText = '';

    if (file.name.toLowerCase().endsWith('.pdf')) {
      // unpdf will now accept this data format perfectly
      const result = await extractText(data, { mergePages: true });
      extractedText = result.text;
    } else {
      // Fallback for .txt files
      const decoder = new TextDecoder();
      extractedText = decoder.decode(data);
    }

    return NextResponse.json({ text: extractedText });
    
  } catch (error: any) {
    console.error('Error parsing document:', error);
    return NextResponse.json({ error: error.message || 'Failed to parse document' }, { status: 500 });
  }
}