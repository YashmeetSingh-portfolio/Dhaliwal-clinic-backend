import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.API_KEY;
const mongoUri = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());

// Create Gemini AI instance
const genAI = new GoogleGenAI({ apiKey });

// MongoDB connection
let db;
let creditsCollection;
let sessionHistoryCollection;
let couponsCollection;

// Connect to MongoDB
async function connectToMongo() {
  try {
    if (mongoUri) {
      const client = new MongoClient(mongoUri);
      await client.connect();
      console.log('Connected to MongoDB Atlas');
      
      db = client.db('dhclinic');
      creditsCollection = db.collection('userCredits');
      sessionHistoryCollection = db.collection('sessionHistory');
      couponsCollection = db.collection('coupons');
      
      await creditsCollection.createIndex({ sessionId: 1 }, { unique: true });
      await sessionHistoryCollection.createIndex({ sessionId: 1 }, { unique: true });
      await couponsCollection.createIndex({ code: 1 }, { unique: true });
      
      console.log('MongoDB collections and indexes initialized');
    } else {
      console.log('MongoDB URI not provided, using in-memory storage');
    }
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    console.log('Falling back to in-memory storage');
  }
}

// In-memory fallback
const sessionHistory = {};
const userCredits = {};

// Endpoint to get credits
app.get('/get-credits/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  
  try {
    if (creditsCollection) {
      const userCredit = await creditsCollection.findOne({ sessionId });
      
      if (userCredit) {
        return res.json({ credits: userCredit.credits });
      } else {
        const defaultCredits = 7;
        const isUserAccount = sessionId.startsWith('user-');
        const userId = isUserAccount ? sessionId.replace('user-', '') : null;
        
        await creditsCollection.insertOne({ 
          sessionId, 
          userId,
          isUserAccount,
          credits: defaultCredits,
          createdAt: new Date(),
          lastUpdated: new Date()
        });
        return res.json({ credits: defaultCredits });
      }
    } else {
      const credits = userCredits[sessionId] ?? 7;
      return res.json({ credits });
    }
  } catch (err) {
    console.error('Error getting credits:', err);
    const credits = userCredits[sessionId] ?? 7;
    return res.json({ credits });
  }
});

// Endpoint to generate content
app.post('/generate-content', async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ error: 'Prompt and sessionId are required.' });
  }

  let credits = 7;

  try {
    if (creditsCollection) {
      let userCredit = await creditsCollection.findOne({ sessionId });
      
      if (userCredit) {
        credits = userCredit.credits;
      } else {
        const isUserAccount = sessionId.startsWith('user-');
        const userId = isUserAccount ? sessionId.replace('user-', '') : null;
        
        await creditsCollection.insertOne({ 
          sessionId, 
          userId,
          isUserAccount,
          credits: 7,
          createdAt: new Date(),
          lastUpdated: new Date()
        });
      }
    } 
  } catch (err) {
    console.error('Error getting credits:', err);
    if (userCredits[sessionId] === undefined) {
      userCredits[sessionId] = 7;
    }
    credits = userCredits[sessionId];
  }

  if (credits <= 0) {
    return res.status(403).json({
      error: 'Insufficient credits. Please recharge your credits or buy a monthly plan.'
    });
  }

  const systemPrompt = `
You are an AI Health Assistant integrated into a medical clinic website. Your purpose is to assist patients by answering health-related questions in a simple and easy-to-understand way.

Instructions:
- Only respond if the question is clearly related to health, the human body, symptoms, prevention, hygiene, medicine, or well-being.
- If the question is NOT health-related, respond with: "This question is not related to health. Please ask a health-related question."

Formatting and Language:
- Keep your answers short and to the point. if the person is asking about some symtom cause dont respond just saying serious condition name the condition also.
- Use simple, everyday words that even less-educated users can understand easily.
- Avoid using medical jargon unless absolutely necessary (and explain it if used).
- Reply in the **same language** in which the question was asked.

Start the conversation now.
`;

  let currentSessionHistory = [];
  
  try {
    if (sessionHistoryCollection) {
      const existingSession = await sessionHistoryCollection.findOne({ sessionId });
      
      if (existingSession && existingSession.messages) {
        currentSessionHistory = existingSession.messages;
      } else {
        const systemMessage = { role: 'user', parts: [{ text: systemPrompt }], timestamp: new Date() };
        await sessionHistoryCollection.insertOne({ sessionId, messages: [systemMessage], createdAt: new Date() });
        currentSessionHistory = [systemMessage];
      }
      
      await sessionHistoryCollection.updateOne(
        { sessionId },
        { $push: { messages: { role: 'user', parts: [{ text: prompt }], timestamp: new Date() } } }
      );
      
      const updatedSession = await sessionHistoryCollection.findOne({ sessionId });
      currentSessionHistory = updatedSession.messages;
    } else {
      if (!sessionHistory[sessionId]) {
        sessionHistory[sessionId] = [{ role: 'user', parts: [{ text: systemPrompt }] }];
      }
      sessionHistory[sessionId].push({ role: 'user', parts: [{ text: prompt }] });
      currentSessionHistory = sessionHistory[sessionId];
    }
  } catch (err) {
    console.error('Error managing session history:', err);
    if (!sessionHistory[sessionId]) {
      sessionHistory[sessionId] = [{ role: 'user', parts: [{ text: systemPrompt }] }];
    }
    sessionHistory[sessionId].push({ role: 'user', parts: [{ text: prompt }] });
    currentSessionHistory = sessionHistory[sessionId];
  }

  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: currentSessionHistory
    });

    const aiReply = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiReply) {
      return res.status(500).json({ error: 'No valid text response from Gemini.' });
    }

    try {
      if (creditsCollection) {
        await creditsCollection.updateOne(
          { sessionId },
          { $inc: { credits: -1 }, $set: { lastUpdated: new Date() } }
        );
      } else {
        userCredits[sessionId] -= 1;
      }
    } catch (err) {
      console.error('Error updating credits:', err);
      userCredits[sessionId] -= 1;
    }

    try {
      if (sessionHistoryCollection) {
        await sessionHistoryCollection.updateOne(
          { sessionId },
          { $push: { messages: { role: 'model', parts: [{ text: aiReply }], timestamp: new Date() } } }
        );
      } else {
        sessionHistory[sessionId].push({ role: 'model', parts: [{ text: aiReply }] });
      }
    } catch (err) {
      console.error('Error storing session history:', err);
      sessionHistory[sessionId].push({ role: 'model', parts: [{ text: aiReply }] });
    }

      let updatedCredits;
      try {
        if (creditsCollection) {
          const updatedUser = await creditsCollection.findOne({ sessionId });
          updatedCredits = updatedUser ? updatedUser.credits : 0;
        } else {
          updatedCredits = userCredits[sessionId];
        }
      } catch (err) {
        console.error('Error getting updated credits:', err);
        updatedCredits = userCredits[sessionId];
      }
      
      res.json({ generatedText: aiReply, creditsLeft: updatedCredits });
  } catch (err) {
    console.error('Error generating content:', err);
    res.status(500).json({ error: 'Failed to generate content.' });
  }
});


async function startServer() {
  try {
    await connectToMongo();

    app.post('/add-credits', async (req, res) => {
      const { sessionId, creditsToAdd } = req.body;
      
      if (!sessionId || !creditsToAdd || isNaN(creditsToAdd) || creditsToAdd <= 0) {
        return res.status(400).json({ error: 'Valid sessionId and creditsToAdd are required.' });
      }
      
      try {
        if (creditsCollection) {
          const userCredit = await creditsCollection.findOne({ sessionId });
          
          if (userCredit) {
            await creditsCollection.updateOne(
              { sessionId },
              { 
                $inc: { credits: creditsToAdd },
                $set: { lastUpdated: new Date() }
              }
            );
            
            const updatedUser = await creditsCollection.findOne({ sessionId });
            return res.json({ 
              success: true, 
              message: `Added ${creditsToAdd} credits successfully.`,
              credits: updatedUser.credits 
            });
          } else {
            return res.status(404).json({ error: 'User not found.' });
          }
        } else {
          if (userCredits[sessionId] !== undefined) {
            userCredits[sessionId] += creditsToAdd;
            return res.json({ 
              success: true, 
              message: `Added ${creditsToAdd} credits successfully.`,
              credits: userCredits[sessionId] 
            });
          } else {
            return res.status(404).json({ error: 'User not found.' });
          }
        }
      } catch (err) {
        console.error('Error adding credits:', err);
        return res.status(500).json({ error: 'Failed to add credits.' });
      }
    });
    
    app.post('/api/admin/generate-coupon', async (req, res) => {
        if (!couponsCollection) {
            return res.status(503).json({ error: 'Database service is not available.' });
        }

        const { credits, planTitle } = req.body;

        if (!credits || isNaN(credits) || credits <= 0 || !planTitle) {
            return res.status(400).json({ error: 'A positive number of credits and a planTitle are required.' });
        }

        try {
            const couponCode = crypto.randomBytes(4).toString('hex').toUpperCase();
            const newCoupon = {
                code: couponCode,
                credits: parseInt(credits, 10),
                planTitle: planTitle,
                isUsed: false,
                createdAt: new Date(),
            };

            const result = await couponsCollection.insertOne(newCoupon);
            const createdCoupon = await couponsCollection.findOne({ _id: result.insertedId });
            
            console.log(`Generated new coupon for plan "${planTitle}": ${couponCode}`);
            res.status(201).json({ message: 'Coupon generated successfully', coupon: createdCoupon });

        } catch (err) {
            console.error('Error generating coupon:', err);
            res.status(500).json({ error: 'Failed to generate coupon.' });
        }
    });

    // 👇 FULLY REVISED AND MORE ROBUST REDEMPTION ENDPOINT 👇
    app.post('/api/coupons/redeem', async (req, res) => {
      if (!db) {
        return res.status(503).json({ error: 'Database service is not available.' });
      }

      const { couponCode, sessionId, planTitle } = req.body;

      if (!couponCode || !sessionId || !planTitle) {
        return res.status(400).json({ error: 'Coupon code, session ID, and plan title are required.' });
      }

      try {
        // Step 1: Find a valid, unused coupon
        const coupon = await couponsCollection.findOne({ 
          code: couponCode.toUpperCase(),
          isUsed: false 
        });

        // Step 2: Validate the coupon's existence and plan
        if (!coupon) {
          return res.status(404).json({ error: 'Invalid or already used coupon code.' });
        }
        if (coupon.planTitle !== planTitle) {
          return res.status(400).json({ error: `This coupon is only valid for the "${coupon.planTitle}" plan.` });
        }

        // Step 3: Explicitly find or create the user's credit document
        const creditsToAdd = coupon.credits;
        let userCreditDoc = await creditsCollection.findOne({ sessionId });

        if (userCreditDoc) {
          // If user exists, increment their credits
          await creditsCollection.updateOne(
            { sessionId },
            { 
              $inc: { credits: creditsToAdd },
              $set: { lastUpdated: new Date() }
            }
          );
        } else {
          // If user does NOT exist, create a new document for them
          const isUserAccount = sessionId.startsWith('user-');
          const userId = isUserAccount ? sessionId.replace('user-', '') : null;
          await creditsCollection.insertOne({
            sessionId,
            userId,
            isUserAccount,
            credits: creditsToAdd, // Start with the credits from the coupon
            createdAt: new Date(),
            lastUpdated: new Date()
          });
        }
        
        // Step 4: Mark the coupon as used
        await couponsCollection.updateOne(
          { _id: coupon._id },
          { 
            $set: { isUsed: true, usedBy: sessionId, usedAt: new Date() } 
          }
        );

        // Step 5: Get the final, updated credit count
        const updatedUser = await creditsCollection.findOne({ sessionId });
        console.log(`Coupon ${couponCode} redeemed by ${sessionId} for plan "${planTitle}". Credits added: ${creditsToAdd}.`);

        res.status(200).json({
          success: true,
          message: `Successfully added ${creditsToAdd} credits!`,
          creditsAdded: creditsToAdd,
          newTotalCredits: updatedUser.credits
        });

      } catch (err) {
        console.error('Error redeeming coupon:', err);
        res.status(500).json({ error: 'Server error while redeeming coupon.' });
      }
    });

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`Credits system: ${db ? 'MongoDB Atlas' : 'In-memory storage'}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();