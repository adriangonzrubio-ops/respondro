import { NextResponse } from 'next/server';
const pdf = require('pdf-parse');

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // Convert the uploaded file into a format Node.js can read
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let extractedText = '';

    // Route logic based on file type
    if (file.name.toLowerCase().endsWith('.pdf')) {
      const data = await pdf(buffer);
      extractedText = data.text;
    } else {
      // Fallback for standard .txt files
      extractedText = buffer.toString('utf-8');
    }

    // Send the extracted text back to the frontend
    return NextResponse.json({ text: extractedText });
    
  } catch (error) {
    console.error('Error parsing document:', error);
    return NextResponse.json({ error: 'Failed to parse document' }, { status: 500 });
  }
}