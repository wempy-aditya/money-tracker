const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');
const db = firestore();
const goalsCollection = db.collection('goals');

// Get all goals
router.get('/', async (req, res) => {
    try {
        const goalsSnapshot = await goalsCollection.get();
        const goals = [];
        
        goalsSnapshot.forEach(doc => {
            goals.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        res.json(goals);
    } catch (error) {
        console.error('Error getting goals:', error);
        res.status(500).json({ error: 'Failed to get goals' });
    }
});

// Get a specific goal
router.get('/:id', async (req, res) => {
    try {
        const goalDoc = await goalsCollection.doc(req.params.id).get();
        
        if (!goalDoc.exists) {
            return res.status(404).json({ error: 'Goal not found' });
        }
        
        res.json({
            id: goalDoc.id,
            ...goalDoc.data()
        });
    } catch (error) {
        console.error('Error getting goal:', error);
        res.status(500).json({ error: 'Failed to get goal' });
    }
});

// Create a new goal
router.post('/', async (req, res) => {
    try {
        const { name, targetAmount, currentAmount, targetDate, description } = req.body;
        
        // Validate required fields
        if (!name || !targetAmount || !targetDate) {
            return res.status(400).json({ error: 'Name, target amount, and target date are required' });
        }
        
        // Create new goal
        const newGoal = {
            name,
            targetAmount: Number(targetAmount),
            currentAmount: Number(currentAmount || 0),
            targetDate,
            description: description || '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // Check if there's enough frozen funds available
        const walletsSnapshot = await db.collection('wallets').get();
        let totalFrozen = 0;
        
        walletsSnapshot.forEach(doc => {
            const wallet = doc.data();
            totalFrozen += wallet.frozen || 0;
        });
        
        const goalsSnapshot = await goalsCollection.get();
        let allocatedToGoals = 0;
        
        goalsSnapshot.forEach(doc => {
            const goal = doc.data();
            allocatedToGoals += goal.currentAmount || 0;
        });
        
        const remainingFrozen = totalFrozen - allocatedToGoals;
        
        if (newGoal.currentAmount > remainingFrozen) {
            return res.status(400).json({ error: 'Not enough frozen funds available' });
        }
        
        const docRef = await goalsCollection.add(newGoal);
        
        res.status(201).json({
            id: docRef.id,
            ...newGoal
        });
    } catch (error) {
        console.error('Error creating goal:', error);
        res.status(500).json({ error: 'Failed to create goal' });
    }
});

// Update a goal
router.put('/:id', async (req, res) => {
    try {
        const goalId = req.params.id;
        const { name, targetAmount, currentAmount, targetDate, description } = req.body;
        
        // Validate required fields
        if (!name || !targetAmount || !targetDate) {
            return res.status(400).json({ error: 'Name, target amount, and target date are required' });
        }
        
        // Get the original goal
        const goalDoc = await goalsCollection.doc(goalId).get();
        
        if (!goalDoc.exists) {
            return res.status(404).json({ error: 'Goal not found' });
        }
        
        const originalGoal = goalDoc.data();
        
        // If we're increasing the allocation, check if there's enough frozen funds
        if (Number(currentAmount) > originalGoal.currentAmount) {
            const additionalAllocation = Number(currentAmount) - originalGoal.currentAmount;
            
            // Check if there's enough frozen funds available
            const walletsSnapshot = await db.collection('wallets').get();
            let totalFrozen = 0;
            
            walletsSnapshot.forEach(doc => {
                const wallet = doc.data();
                totalFrozen += wallet.frozen || 0;
            });
            
            const goalsSnapshot = await goalsCollection.get();
            let allocatedToGoals = 0;
            
            goalsSnapshot.forEach(doc => {
                if (doc.id !== goalId) { // Exclude the current goal
                    const goal = doc.data();
                    allocatedToGoals += goal.currentAmount || 0;
                }
            });
            
            allocatedToGoals += originalGoal.currentAmount; // Add the original amount
            
            const remainingFrozen = totalFrozen - allocatedToGoals;
            
            if (additionalAllocation > remainingFrozen) {
                return res.status(400).json({ error: 'Not enough frozen funds available' });
            }
        }
        
        // Update goal
        const updatedGoal = {
            name,
            targetAmount: Number(targetAmount),
            currentAmount: Number(currentAmount),
            targetDate,
            description: description || '',
            updatedAt: new Date().toISOString()
        };
        
        await goalsCollection.doc(goalId).update(updatedGoal);
        
        res.json({
            id: goalId,
            ...updatedGoal
        });
    } catch (error) {
        console.error('Error updating goal:', error);
        res.status(500).json({ error: 'Failed to update goal' });
    }
});

// Delete a goal
router.delete('/:id', async (req, res) => {
    try {
        const goalId = req.params.id;
        
        // Check if goal exists
        const goalDoc = await goalsCollection.doc(goalId).get();
        
        if (!goalDoc.exists) {
            return res.status(404).json({ error: 'Goal not found' });
        }
        
        await goalsCollection.doc(goalId).delete();
        
        res.json({ message: 'Goal deleted successfully' });
    } catch (error) {
        console.error('Error deleting goal:', error);
        res.status(500).json({ error: 'Failed to delete goal' });
    }
});

module.exports = router;