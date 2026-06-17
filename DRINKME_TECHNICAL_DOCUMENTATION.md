# DrinkMe Technical Documentation

## Project Overview
DrinkMe is a comprehensive social media platform for alcoholic and non-alcoholic beverages, combining AI-powered bottle scanning, recipe generation, social networking features, and inventory management.

---

## Architecture Overview

### Technology Stack

#### Frontend (Web)
- **Framework**: React 18.3.1 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS + shadcn/ui components
- **State Management**: TanStack Query v5
- **Routing**: Wouter
- **UI Components**: shadcn/ui (Radix UI based)

#### Frontend (Mobile)
- **Framework**: React Native with Expo SDK 50
- **Language**: TypeScript
- **Navigation**: React Navigation v6
- **Styling**: NativeWind (Tailwind for React Native)
- **State Management**: TanStack Query v5
- **Camera/Scanner**: Expo Camera & Barcode Scanner

#### Backend
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Firebase Auth with JWT tokens
- **File Storage**: Firebase Storage
- **Session Management**: PostgreSQL with connect-pg-simple

#### External Services
- **AI/ML**: OpenAI GPT-4o API
- **Maps**: Google Maps/Places API
- **Product Data**: Open Food Facts API
- **Hosting**: Replit Deployments

---

## Core Features

### 1. Authentication System
- **Firebase Authentication** for user identity management
- **JWT Token Exchange** for backend authorization
- **Session Persistence** in PostgreSQL
- **Social Login** support (Google, Apple)

### 2. Social Networking
- **User Profiles**: Customizable profiles with bio, avatar, verification
- **Follow System**: Drink partners/friends functionality
- **Activity Feed**: Timeline of posts from followed users
- **Notifications**: Real-time alerts for interactions

### 3. Drink Posts & Discovery
- **Post Creation**: Share drinks with photos, ratings, recipes
- **Rich Media**: Support for images and videos
- **Location Tagging**: Google Places integration
- **Categories**: Cocktails, Wine, Beer, Non-Alcoholic, etc.

### 4. AI-Powered Features
- **Bottle Scanner**: Barcode scanning with product detection
- **Recipe Generation**: AI-generated cocktail recipes
- **Smart Recommendations**: Personalized drink suggestions
- **Image Recognition**: Bottle/drink identification from photos

### 5. Smart Bar Inventory
- **Inventory Management**: Track bottles and ingredients
- **Recipe Matching**: Find recipes based on available ingredients
- **Shopping Lists**: Generate lists for missing ingredients
- **Expiry Tracking**: Monitor product shelf life

### 6. Social Interactions
- **Likes & Saves**: Bookmark favorite drinks
- **Comments**: Nested comment threads
- **Sharing**: Share posts to chat or external platforms
- **Stories**: 24-hour ephemeral content

### 7. Real-Time Chat
- **Direct Messaging**: 1-on-1 conversations
- **Message Types**: Text, images, post sharing
- **Read Receipts**: Message delivery status
- **Notifications**: Push notifications for new messages

### 8. Explore & Discovery
- **Location-Based**: Find drinks and venues nearby
- **Search**: Full-text search across posts and users
- **Trending**: Popular drinks and hashtags
- **Categories**: Browse by drink type

---

## Database Schema

### Core Tables
```sql
-- Users
users (
  id: VARCHAR (Firebase UID)
  email: VARCHAR
  username: VARCHAR
  displayName: VARCHAR
  profileImageUrl: VARCHAR
  bio: TEXT
  isVerified: BOOLEAN
  createdAt: TIMESTAMP
)

-- Drinks/Posts
drinks (
  id: SERIAL
  userId: VARCHAR
  title: VARCHAR
  description: TEXT
  recipe: TEXT
  drinkType: VARCHAR
  rating: INTEGER
  imageUrl: VARCHAR
  location: VARCHAR
  placeId: VARCHAR
  ingredients: TEXT[]
  isAlcoholic: BOOLEAN
  createdAt: TIMESTAMP
)

-- Social Relations
follows (
  followerId: VARCHAR
  followingId: VARCHAR
  createdAt: TIMESTAMP
)

-- Interactions
likes (
  userId: VARCHAR
  drinkId: INTEGER
  createdAt: TIMESTAMP
)

comments (
  id: SERIAL
  userId: VARCHAR
  drinkId: INTEGER
  content: TEXT
  parentId: INTEGER
  createdAt: TIMESTAMP
)

-- Messaging
conversations (
  id: SERIAL
  participant1Id: VARCHAR
  participant2Id: VARCHAR
  lastMessageAt: TIMESTAMP
)

messages (
  id: SERIAL
  conversationId: INTEGER
  senderId: VARCHAR
  content: TEXT
  messageType: VARCHAR
  isRead: BOOLEAN
  createdAt: TIMESTAMP
)

-- Inventory
smart_bar_items (
  id: SERIAL
  userId: VARCHAR
  name: VARCHAR
  category: VARCHAR
  quantity: INTEGER
  unit: VARCHAR
  expiryDate: DATE
)
```

---

## API Endpoints

### Authentication
```
POST   /api/auth/firebase-login    - Exchange Firebase token for JWT
GET    /api/auth/user              - Get current user
POST   /api/auth/logout            - Logout user
```

### Users
```
GET    /api/users/:id              - Get user profile
PUT    /api/users/:id              - Update user profile
GET    /api/users/search           - Search users
GET    /api/users/drink-partners   - Get friends list
```

### Drinks/Posts
```
GET    /api/drinks                 - Get feed posts
POST   /api/drinks                 - Create new post
GET    /api/drinks/:id             - Get specific post
PUT    /api/drinks/:id             - Update post
DELETE /api/drinks/:id             - Delete post
GET    /api/drinks/user/:userId   - Get user's posts
```

### Social Interactions
```
POST   /api/drinks/:id/like       - Like a post
DELETE /api/drinks/:id/like       - Unlike a post
POST   /api/drinks/:id/save       - Save a post
DELETE /api/drinks/:id/save       - Unsave a post
GET    /api/drinks/:id/comments   - Get comments
POST   /api/drinks/:id/comments   - Add comment
```

### Messaging
```
GET    /api/conversations          - Get conversations
POST   /api/conversations          - Create conversation
GET    /api/conversations/:id/messages - Get messages
POST   /api/conversations/:id/messages - Send message
POST   /api/conversations/:id/read - Mark as read
```

### Smart Bar
```
GET    /api/smart-bar              - Get inventory
POST   /api/smart-bar              - Add item
PUT    /api/smart-bar/:id         - Update item
DELETE /api/smart-bar/:id         - Remove item
POST   /api/smart-bar/recipes     - Get matching recipes
```

### AI Features
```
POST   /api/ai/scan-barcode       - Process barcode scan
POST   /api/ai/generate-recipe    - Generate recipe
POST   /api/ai/identify-bottle    - Identify from image
```

### Notifications
```
GET    /api/notifications          - Get notifications
GET    /api/notifications/count    - Get unread count
PATCH  /api/notifications/read-all - Mark all as read
```

---

## Environment Variables

### Backend (.env)
```env
# Database
DATABASE_URL=postgresql://user:pass@host/db
PGHOST=localhost
PGPORT=5432
PGUSER=user
PGPASSWORD=password
PGDATABASE=drinkme

# Firebase Admin SDK
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account"...}

# OpenAI
OPENAI_API_KEY=sk-...

# Session
SESSION_SECRET=your-secret-key

# Server
PORT=5000
NODE_ENV=development
```

### Frontend Web (.env)
```env
# Firebase Client SDK
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...

# Google Maps
VITE_GOOGLE_MAPS_API_KEY=...
```

### Mobile App (.env)
```env
# Firebase
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...

# Backend API
EXPO_PUBLIC_API_URL=http://localhost:5000

# Google Maps
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=...
```

---

## Deployment

### Backend Deployment (Replit)
1. Push code to Replit
2. Set environment variables in Secrets
3. Configure PostgreSQL database
4. Deploy via Replit Deployments
5. Domain: `your-app.replit.app`

### Web Frontend Deployment
- Hosted alongside backend on Replit
- Served via Express static files
- Build: `npm run build`

### Mobile App Deployment

#### iOS
1. Build with EAS: `eas build --platform ios`
2. Submit to App Store: `eas submit -p ios`
3. TestFlight for beta testing

#### Android
1. Build with EAS: `eas build --platform android`
2. Submit to Play Store: `eas submit -p android`
3. Internal testing track available

---

## Security Considerations

### Authentication
- Firebase handles user authentication
- JWT tokens for API authorization
- Session management in PostgreSQL
- Token refresh mechanism

### Data Protection
- HTTPS enforcement in production
- Input validation with Zod schemas
- SQL injection prevention (Drizzle ORM)
- XSS protection

### API Security
- Rate limiting on endpoints
- CORS configuration
- Authentication middleware
- Request validation

### File Upload
- File type validation
- Size limits (5MB for images)
- Secure storage in Firebase
- CDN delivery

---

## Performance Optimizations

### Frontend
- Code splitting with React.lazy()
- Image lazy loading
- TanStack Query caching
- Optimistic UI updates
- Virtual scrolling for lists

### Backend
- Database indexing
- Query optimization
- Connection pooling
- Response compression
- CDN for static assets

### Mobile
- Hermes JS engine (Android)
- Image caching
- FlatList optimization
- Minimal re-renders
- Async storage

---

## Monitoring & Analytics

### Error Tracking
- Console logging
- Error boundaries (React)
- Backend error logs
- Database query logs

### Performance Monitoring
- API response times
- Database query performance
- Frontend bundle size
- Mobile app performance

### User Analytics
- User engagement metrics
- Feature usage tracking
- Error rates
- Performance metrics

---

## Development Workflow

### Version Control
- Git for source control
- Feature branch workflow
- Pull request reviews
- Semantic versioning

### Testing
- Unit tests with Jest
- Integration tests
- E2E tests (Cypress/Detox)
- Manual QA testing

### CI/CD
- Automated builds
- Test automation
- Deployment pipelines
- Environment management

---

## Future Enhancements

### Planned Features
1. **AI Sommelier**: Wine pairing recommendations
2. **Social Events**: Drink tasting events
3. **Rewards System**: Gamification elements
4. **Business Accounts**: For bars/restaurants
5. **Advanced Analytics**: Consumption tracking
6. **Voice Commands**: Voice-activated features
7. **AR Features**: Augmented reality bottle scanning
8. **Subscription Tiers**: Premium features

### Technical Improvements
1. **Microservices**: Service separation
2. **GraphQL**: API migration
3. **Redis Cache**: Performance boost
4. **WebSocket**: Real-time updates
5. **PWA**: Progressive web app
6. **Kubernetes**: Container orchestration
7. **ML Pipeline**: Advanced recommendations
8. **CDN**: Global content delivery

---

## Support & Resources

### Documentation Links
- [React Documentation](https://react.dev/)
- [React Native Docs](https://reactnative.dev/)
- [Expo Documentation](https://docs.expo.dev/)
- [Firebase Docs](https://firebase.google.com/docs)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)
- [Drizzle ORM](https://orm.drizzle.team/)

### API Documentation
- OpenAI API: https://platform.openai.com/docs
- Google Maps: https://developers.google.com/maps
- Open Food Facts: https://world.openfoodfacts.org/data

### Development Tools
- Postman/Insomnia for API testing
- pgAdmin for database management
- React DevTools
- Expo DevTools

---

**Last Updated**: January 2025  
**Version**: 1.0.0  
**Platform**: DrinkMe - Social Beverage Discovery