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

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let extractedText = '';

    if (file.name.toLowerCase().endsWith('.pdf')) {
      // unpdf handles the serverless environment perfectly
      const result = await extractText(buffer, { mergePages: true });
      extractedText = result.text;
    } else {
      extractedText = buffer.toString('utf-8');
    }

    return NextResponse.json({ text: extractedText });
    
  } catch (error: any) {
    console.error('Error parsing document:', error);
    return NextResponse.json({ error: error.message || 'Failed to parse document' }, { status: 500 });
  }
}