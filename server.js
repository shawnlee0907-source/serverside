const express = require('express');
const app = express();
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const methodOverride = require('method-override');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

app.set('view engine', 'ejs');
app.set('trust proxy', 1);                           // Render 必加
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));     // 取代 formidable
app.use(express.json());
app.use(methodOverride('_method'));

// Session – Render 完全穩定設定（secure + sameSite:none）
app.use(session({
    secret: process.env.SESSION_SECRET || 'comp3810sef-group19-super-secret-2025',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI || 'mongodb+srv://123:123456dllm@cluster0.xovjzrh.mongodb.net/flightdb'
    }),
    cookie: {
        secure: true,          // Render HTTPS 必須
        httpOnly: true,
        sameSite: 'none',      // 解決登入後跳唔到 list
        maxAge: 1000 * 60 * 60 * 24
    }
}));

app.use(passport.initialize());
app.use(passport.session());

const uri = process.env.MONGODB_URI || 'mongodb+srv://123:123456dllm@cluster0.xovjzrh.mongodb.net/flightdb';
const client = new MongoClient(uri);
let db;
client.connect().then(() => {
    db = client.db('flightdb');
    console.log('MongoDB connected');
}).catch(err => console.error('MongoDB connection error:', err));

// Middleware
const requireLogin = (req, res, next) => {
    if (req.session.user || req.user) {
        req.session.user = req.user || req.session.user;
        next();
    } else res.redirect('/login');
};

// Google OAuth (加分)
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || '687093134190-btasb8hs3bg050cqm5muna8kokjeat8c.apps.googleusercontent.com',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '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',
    callbackURL: (process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000') + '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
    let user = await db.collection('users').findOne({ googleId: profile.id });
    if (!user) {
        user = {
            googleId: profile.id,
            name: profile.displayName,
            email: profile.emails?.[0]?.value || 'no-email@gmail.com',
            userId: 'google_' + Date.now(),
            createdAt: new Date()
        };
        await db.collection('users').insertOne(user);
    }
    return done(null, user);
}));
passport.serializeUser((user, done) => done(null, user.userId));
passport.deserializeUser(async (id, done) => {
    const user = await db.collection('users').findOne({ userId: id });
    done(null, user);
});

// ==================== Routes ====================

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.render('register', { error: 'All fields required' });
    const existing = await db.collection('users').findOne({ username });
    if (existing) return res.render('register', { error: 'Username exists' });
    const hash = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({ username, password: hash, name, userId: 'u' + Date.now() });
    res.render('login', { error: 'Registered! Please login.' });
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ username });
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { id: user.userId, name: user.name || username };
        return res.redirect('/list');
    }
    res.render('login', { error: 'Invalid credentials' });
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => { req.session.user = { id: req.user.userId, name: req.user.name }; res.redirect('/list'); });

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// Dashboard
app.get('/list', requireLogin, async (req, res) => {
    const userId = req.session.user.id || req.user?.userId;
    const flights = await db.collection('flights').find({ userid: userId }).sort({ createdAt: -1 }).toArray();
    res.render('list', { flights, user: req.session.user || req.user, success: req.query.success });
});

// Add Flight
app.post('/flights', requireLogin, async (req, res) => {
    const userId = req.session.user.id || req.user?.userId;
    const { flightNumber, destination, hours, minutes, gate, status, airline, departureAirport, arrivalAirport } = req.body;
    const newFlight = {
        userid: userId, flightNumber, destination, hours, minutes,
        gate: gate || 'N/A', status: status || 'On Time', airline: airline || '',
        departureAirport: departureAirport || 'HKG', arrivalAirport: arrivalAirport || destination || 'N/A',
        createdAt: new Date()
    };
    if (req.files?.filetoupload?.size > 0) {
        const data = await fs.readFile(req.files.filetoupload.path);
        newFlight.photo = data.toString('base64');
    }
    await db.collection('flights').insertOne(newFlight);
    res.redirect('/list?success=Flight added');
});

// Edit page
app.get('/edit', requireLogin, async (req, res) => {
    const flight = await db.collection('flights').findOne({ _id: new ObjectId(req.query._id) });
    if (!flight) return res.send('Flight not found');
    res.render('edit', { flight, user: req.session.user || req.user });
});
app.put('/flights/:id', requireLogin, async (req, res) => {
    await db.collection('flights').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
    );
    res.redirect('/list?success=Updated');
});

// Delete
app.delete('/flights/:flightNumber', requireLogin, async (req, res) => {
    await db.collection('flights').deleteOne({ flightNumber: req.params.flightNumber });
    res.redirect('/list?success=Deleted');
});

// 關鍵：你之前遺漏嘅 Details route（解決 500 error）
// 改成呢段（加咗 userid 檢查 + 更穩陣）
app.get('/details', requireLogin, async (req, res) => {
    try {
        const flightId = req.query.id || req.query._id;
        if (!flightId) return res.render('info', { message: 'No flight ID provided', user: req.session.user || req.user });

        const flight = await db.collection('flights').findOne({ 
            _id: new ObjectId(flightId),
            userid: req.session.user.id || req.user?.userId   // 關鍵！確保係呢個 user 嘅 flight
        });

        if (!flight) {
            return res.render('info', { 
                message: 'Flight not found or access denied', 
                user: req.session.user || req.user 
            });
        }

        res.render('details', { flight, user: req.session.user || req.user });
    } catch (err) {
        console.error('Details error:', err);
        res.render('info', { message: 'Invalid flight ID', user: req.session.user || req.user });
    }
});

// RESTful API (全部要登入)
app.post('/api/flights', requireLogin, async (req, res) => {
    const doc = { ...req.body, userid: req.session.user.id || req.user.userId };
    const result = await db.collection('flights').insertOne(doc);
    res.json({ success: true, id: result.insertedId });
});
app.get('/api/flights', requireLogin, async (req, res) => {
    const flights = await db.collection('flights').find({ userid: req.session.user.id || req.user.userId }).toArray();
    res.json(flights);
});
app.get('/api/flights/:flightNumber', requireLogin, async (req, res) => {
    const flight = await db.collection('flights').findOne({ flightNumber: req.params.flightNumber, userid: req.session.user.id || req.user.userId });
    res.json(flight || { error: 'Not found' });
});
app.put('/api/flights/:flightNumber', requireLogin, async (req, res) => {
    const result = await db.collection('flights').updateOne(
        { flightNumber: req.params.flightNumber, userid: req.session.user.id || req.user.userId },
        { $set: req.body }
    );
    res.json({ success: result.modifiedCount > 0 });
});
app.delete('/api/flights/:flightNumber', requireLogin, async (req, res) => {
    const result = await db.collection('flights').deleteOne({ flightNumber: req.params.flightNumber, userid: req.session.user.id || req.user.userId });
    res.json({ success: result.deletedCount > 0 });
});

app.get('/', requireLogin, (req, res) => res.redirect('/list'));
app.get('*', (req, res) => res.render('info', { message: 'Page not found', user: req.session.user || req.user || null }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
