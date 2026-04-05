
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');


const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();


app.use(cors());
app.use(express.json()); 


const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 

    if (!token) return res.status(401).json({ error: "Access Denied. Please Login." });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or Expired Token." });
        req.user = user;
        next();
    });
};


const authorizeAdmin = (req, res, next) => {
    if (req.user.role !== 'Admin') {
        return res.status(403).json({ error: "Access Denied. Only Admins can perform this action!" });
    }
    next();
};




app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        
       
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            "INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role",
            [username, hashedPassword, role || 'Staff']
        );
        res.status(201).json({ message: "User created successfully!", user: newUser.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Username already exists or Server Error" });
    }
});


app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

      
        const userRes = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: "Invalid Username or Password" });

        const user = userRes.rows[0];

       
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Invalid Username or Password" });

        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.json({ message: "Login Successful", token, role: user.role, username: user.username });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
});



app.get('/api/customers', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM customers ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
});

app.post('/api/customers', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { customer_name, customer_address, pan_card_number, gst_number, status } = req.body;
        const newCustomer = await pool.query(
            "INSERT INTO customers (customer_name, customer_address, pan_card_number, gst_number, status) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [customer_name, customer_address, pan_card_number, gst_number || null, status || 'Active']
        );
        res.status(201).json(newCustomer.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Failed to add customer. Check PAN/GST uniqueness." });
    }
});



app.get('/api/items', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM items ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
});

app.post('/api/items', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { item_name, selling_price, status } = req.body;
        const newItem = await pool.query(
            "INSERT INTO items (item_name, selling_price, status) VALUES ($1, $2, $3) RETURNING *",
            [item_name, selling_price, status || 'Active']
        );
        res.status(201).json(newItem.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
});


const generateInvoiceId = () => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = 'INVC';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

app.post('/api/invoices', authenticateToken, async (req, res) => {
    const { customer_id, items } = req.body; 

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); 

        const customerRes = await client.query('SELECT gst_number FROM customers WHERE id = $1', [customer_id]);
        if (customerRes.rows.length === 0) throw new Error("Customer not found!");
        
        const hasGST = customerRes.rows[0].gst_number ? true : false;

        let totalAmount = 0;
        items.forEach(item => {
            totalAmount += item.quantity * item.unit_price;
        });

        const gstAmount = hasGST ? 0 : (totalAmount * 0.18);
        const netAmount = totalAmount + gstAmount;
        const invoiceId = generateInvoiceId();

        const invoiceInsert = await client.query(
            `INSERT INTO invoices (invoice_id, customer_id, total_amount, gst_amount, net_amount) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id, invoice_id`,
            [invoiceId, customer_id, totalAmount, gstAmount, netAmount]
        );

        const dbInvoiceId = invoiceInsert.rows[0].id;
        const generatedInvoiceId = invoiceInsert.rows[0].invoice_id;

        for (let item of items) {
            const totalPrice = item.quantity * item.unit_price;
            await client.query(
                `INSERT INTO invoice_items (invoice_db_id, item_id, quantity, unit_price, total_price) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [dbInvoiceId, item.item_id, item.quantity, item.unit_price, totalPrice]
            );
        }

        await client.query('COMMIT'); 
        res.status(201).json({ success: true, message: "Invoice Generated!", invoice_id: generatedInvoiceId });

    } catch (err) {
        await client.query('ROLLBACK'); 
        console.error("Transaction Error: ", err.message);
        res.status(500).json({ error: err.message || "Failed to generate invoice" });
    } finally {
        client.release();
    }
});

app.get('/api/invoices', async (req, res) => {
    try {
        const query = `
            SELECT i.id, i.invoice_id, i.total_amount, i.gst_amount, i.net_amount, i.created_at, 
                   c.customer_name 
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            ORDER BY i.id DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});