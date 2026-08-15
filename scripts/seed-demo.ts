import "dotenv/config";
import { db } from "../src/lib/db/client";
import { meals, mealIngredients } from "../src/lib/db/schema";
import { tierForCost } from "../src/lib/tiering";

/**
 * Local-dev-only seed data: hand-authored (not LLM-generated, not priced via
 * Pepesto) so tonight's labeling session has real variety without spending
 * any API credits. Prices here are plausible placeholders, NOT fetched from
 * any pricing adapter. Real pricing only ever comes from priceApprovedMeals()
 * (src/lib/pricing/priceApproved.ts), triggered manually via the queue page
 * or `npm run pipeline:price`. Once ANTHROPIC_API_KEY is set, the real
 * pipeline (npm run pipeline:generate) can supplement or replace this list.
 */
interface DemoMeal {
  name: string;
  description: string;
  primaryProtein: string;
  isClassic: boolean;
  costTwoPerson: number;
  instructions: string[];
  ingredients: { name: string; quantity: string }[];
}

const DEMO_MEALS: DemoMeal[] = [
  // --- Beef ---
  {
    name: "Spaghetti Bolognese",
    description: "Classic beef ragu over spaghetti.",
    primaryProtein: "beef",
    isClassic: true,
    costTwoPerson: 4.8,
    instructions: [
      "Brown 400g beef mince in a large pan.",
      "Add chopped onion, carrot, celery and garlic, cook until soft.",
      "Stir in a tin of chopped tomatoes and a splash of stock, simmer 25 minutes.",
      "Cook 300g spaghetti, combine and serve with parmesan.",
    ],
    ingredients: [
      { name: "beef mince", quantity: "400g" },
      { name: "spaghetti", quantity: "300g" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "onion", quantity: "1" },
      { name: "garlic", quantity: "2 cloves" },
    ],
  },
  {
    name: "Beef and Ale Stew",
    description: "Slow-cooked chunks of beef in a rich ale gravy.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 6.5,
    instructions: [
      "Brown 500g diced beef shin in batches.",
      "Add onion, carrot and a bottle of ale, bring to a simmer.",
      "Cover and cook low for 2.5 hours until tender.",
      "Serve with mash or crusty bread.",
    ],
    ingredients: [
      { name: "diced beef shin", quantity: "500g" },
      { name: "ale", quantity: "330ml" },
      { name: "carrots", quantity: "3" },
      { name: "onion", quantity: "1" },
    ],
  },
  {
    name: "Steak and Chips",
    description: "Pan-seared sirloin with hand-cut chips and peppercorn sauce.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 11.0,
    instructions: [
      "Cut and fry chips until golden.",
      "Season two sirloin steaks and sear 2-3 minutes each side.",
      "Rest the steak, deglaze the pan with cream and peppercorns for the sauce.",
      "Serve steak and chips with the sauce.",
    ],
    ingredients: [
      { name: "sirloin steaks", quantity: "2" },
      { name: "potatoes", quantity: "600g" },
      { name: "double cream", quantity: "100ml" },
      { name: "green peppercorns", quantity: "1 tbsp" },
    ],
  },
  {
    name: "Beef Tacos",
    description: "Spiced beef mince tacos with all the toppings.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 4.2,
    instructions: [
      "Fry 400g beef mince with taco seasoning.",
      "Warm taco shells or tortillas.",
      "Fill with beef, lettuce, cheese, salsa and soured cream.",
    ],
    ingredients: [
      { name: "beef mince", quantity: "400g" },
      { name: "taco shells", quantity: "8" },
      { name: "cheddar cheese", quantity: "100g" },
      { name: "salsa", quantity: "200g" },
    ],
  },
  {
    name: "Cottage Pie",
    description: "Beef mince in gravy topped with creamy mashed potato.",
    primaryProtein: "beef",
    isClassic: true,
    costTwoPerson: 4.5,
    instructions: [
      "Brown 400g beef mince with onion and carrot.",
      "Add stock and simmer 20 minutes.",
      "Top with mashed potato and bake at 200C for 20 minutes.",
    ],
    ingredients: [
      { name: "beef mince", quantity: "400g" },
      { name: "potatoes", quantity: "700g" },
      { name: "beef stock", quantity: "300ml" },
      { name: "carrots", quantity: "2" },
    ],
  },
  {
    name: "Beef Stir Fry",
    description: "Quick sliced beef and vegetable stir fry.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 5.8,
    instructions: [
      "Slice 350g beef strips thinly, marinate in soy sauce.",
      "Stir fry beef in a hot wok until browned, set aside.",
      "Stir fry mixed vegetables, combine with beef and noodles.",
    ],
    ingredients: [
      { name: "beef strips", quantity: "350g" },
      { name: "mixed stir fry vegetables", quantity: "300g" },
      { name: "noodles", quantity: "250g" },
      { name: "soy sauce", quantity: "3 tbsp" },
    ],
  },
  {
    name: "Beef Lasagne",
    description: "Layered pasta bake with beef ragu and bechamel.",
    primaryProtein: "beef",
    isClassic: true,
    costTwoPerson: 6.0,
    instructions: [
      "Make a beef ragu as for bolognese.",
      "Make a bechamel sauce with butter, flour and milk.",
      "Layer lasagne sheets, ragu and bechamel, top with cheese.",
      "Bake at 190C for 35 minutes.",
    ],
    ingredients: [
      { name: "beef mince", quantity: "400g" },
      { name: "lasagne sheets", quantity: "9" },
      { name: "milk", quantity: "500ml" },
      { name: "cheddar cheese", quantity: "150g" },
    ],
  },
  {
    name: "Chilli Con Carne",
    description: "Smoky beef and kidney bean chilli.",
    primaryProtein: "beef",
    isClassic: true,
    costTwoPerson: 4.0,
    instructions: [
      "Brown 400g beef mince with onion and garlic.",
      "Add chilli powder, cumin, chopped tomatoes and kidney beans.",
      "Simmer 30 minutes, serve with rice.",
    ],
    ingredients: [
      { name: "beef mince", quantity: "400g" },
      { name: "kidney beans", quantity: "1 tin" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "rice", quantity: "300g" },
    ],
  },
  {
    name: "Beef Massaman Curry",
    description: "Rich Thai-style coconut curry with tender beef.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 8.5,
    instructions: [
      "Brown 500g diced beef, set aside.",
      "Fry massaman paste, add coconut milk, beef and potatoes.",
      "Simmer 1.5 hours until beef is tender, serve with rice.",
    ],
    ingredients: [
      { name: "diced beef", quantity: "500g" },
      { name: "coconut milk", quantity: "400ml" },
      { name: "massaman curry paste", quantity: "3 tbsp" },
      { name: "potatoes", quantity: "300g" },
    ],
  },
  {
    name: "Beef Burgers",
    description: "Homemade beef patties in brioche buns.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 5.5,
    instructions: [
      "Shape 400g beef mince into two patties, season well.",
      "Fry or grill 4 minutes each side, add cheese to melt.",
      "Serve in toasted brioche buns with salad and sauce.",
    ],
    ingredients: [
      { name: "beef mince", quantity: "400g" },
      { name: "brioche buns", quantity: "2" },
      { name: "cheddar cheese", quantity: "2 slices" },
      { name: "lettuce", quantity: "4 leaves" },
    ],
  },
  {
    name: "Beef Wellington",
    description: "Fillet beef wrapped in mushroom duxelles and puff pastry.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 14.0,
    instructions: [
      "Sear a beef fillet on all sides, cool.",
      "Wrap in mushroom duxelles, parma ham and puff pastry.",
      "Bake at 200C for 25-30 minutes, rest before slicing.",
    ],
    ingredients: [
      { name: "beef fillet", quantity: "500g" },
      { name: "puff pastry", quantity: "500g" },
      { name: "mushrooms", quantity: "300g" },
      { name: "parma ham", quantity: "6 slices" },
    ],
  },
  {
    name: "Beef and Broccoli Noodles",
    description: "Sticky soy beef with broccoli over noodles.",
    primaryProtein: "beef",
    isClassic: false,
    costTwoPerson: 5.6,
    instructions: [
      "Marinate 350g sliced beef in soy, cornflour and ginger.",
      "Fry beef until browned, add broccoli and a sticky soy sauce.",
      "Toss with cooked noodles.",
    ],
    ingredients: [
      { name: "beef strips", quantity: "350g" },
      { name: "broccoli", quantity: "250g" },
      { name: "noodles", quantity: "250g" },
      { name: "soy sauce", quantity: "4 tbsp" },
    ],
  },

  // --- Chicken ---
  {
    name: "Chicken Tikka Masala",
    description: "Creamy spiced curry with grilled chicken.",
    primaryProtein: "chicken",
    isClassic: true,
    costTwoPerson: 6.2,
    instructions: [
      "Marinate 500g diced chicken thigh in yoghurt and tikka spices for 30 minutes.",
      "Grill or pan-fry until charred and cooked through.",
      "Make a sauce with onion, garlic, ginger, tinned tomatoes and cream.",
      "Combine chicken with sauce, simmer 10 minutes, serve with rice and naan.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "500g" },
      { name: "natural yoghurt", quantity: "150g" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "double cream", quantity: "100ml" },
      { name: "basmati rice", quantity: "300g" },
    ],
  },
  {
    name: "Sunday Roast Chicken",
    description: "Whole roast chicken with all the trimmings.",
    primaryProtein: "chicken",
    isClassic: true,
    costTwoPerson: 9.4,
    instructions: [
      "Roast a whole chicken at 200C for around 90 minutes.",
      "Roast potatoes in the fat for the last hour.",
      "Steam carrots and greens, make gravy from the pan juices.",
      "Carve and serve.",
    ],
    ingredients: [
      { name: "whole chicken", quantity: "1.5kg" },
      { name: "potatoes", quantity: "1kg" },
      { name: "carrots", quantity: "4" },
      { name: "chicken stock", quantity: "300ml" },
    ],
  },
  {
    name: "Chicken Fajitas",
    description: "Sizzling chicken and peppers with warm tortillas.",
    primaryProtein: "chicken",
    isClassic: true,
    costTwoPerson: 5.4,
    instructions: [
      "Slice 400g chicken breast and mixed peppers.",
      "Fry with fajita seasoning until chicken is cooked through.",
      "Serve with warm tortillas, soured cream and guacamole.",
    ],
    ingredients: [
      { name: "chicken breast", quantity: "400g" },
      { name: "mixed peppers", quantity: "3" },
      { name: "tortilla wraps", quantity: "6" },
      { name: "soured cream", quantity: "150g" },
    ],
  },
  {
    name: "Chicken Katsu Curry",
    description: "Crispy breaded chicken with a mild curry sauce.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 6.8,
    instructions: [
      "Coat two chicken breasts in flour, egg and panko breadcrumbs.",
      "Fry until golden and cooked through, slice.",
      "Make a curry sauce with onion, curry powder, flour and stock.",
      "Serve chicken over rice with the sauce.",
    ],
    ingredients: [
      { name: "chicken breast", quantity: "2" },
      { name: "panko breadcrumbs", quantity: "100g" },
      { name: "curry powder", quantity: "2 tbsp" },
      { name: "rice", quantity: "300g" },
    ],
  },
  {
    name: "Lemon Chicken Traybake",
    description: "One-tray roasted chicken thighs with lemon and potatoes.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 4.6,
    instructions: [
      "Toss chicken thighs, halved potatoes and lemon wedges in oil and herbs.",
      "Roast at 200C for 40-45 minutes until golden.",
      "Serve with the pan juices spooned over.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "6" },
      { name: "potatoes", quantity: "500g" },
      { name: "lemon", quantity: "1" },
      { name: "mixed herbs", quantity: "1 tbsp" },
    ],
  },
  {
    name: "Chicken Caesar Salad",
    description: "Grilled chicken over crisp lettuce with Caesar dressing.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 5.2,
    instructions: [
      "Grill two seasoned chicken breasts, slice.",
      "Toss romaine lettuce with Caesar dressing, croutons and parmesan.",
      "Top with sliced chicken.",
    ],
    ingredients: [
      { name: "chicken breast", quantity: "2" },
      { name: "romaine lettuce", quantity: "1" },
      { name: "parmesan", quantity: "50g" },
      { name: "croutons", quantity: "80g" },
    ],
  },
  {
    name: "Peri Peri Chicken",
    description: "Spicy grilled chicken with a peri peri glaze.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 6.0,
    instructions: [
      "Marinate chicken thighs in peri peri sauce for at least 20 minutes.",
      "Grill or bake until charred and cooked through.",
      "Serve with corn on the cob and spicy rice.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "6" },
      { name: "peri peri sauce", quantity: "100ml" },
      { name: "corn on the cob", quantity: "2" },
      { name: "rice", quantity: "250g" },
    ],
  },
  {
    name: "Chicken Noodle Soup",
    description: "Comforting broth with chicken, noodles and vegetables.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 3.8,
    instructions: [
      "Simmer chicken thighs in stock with carrot and celery until cooked.",
      "Shred the chicken, return to the pot with noodles.",
      "Simmer until noodles are tender, season and serve.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "300g" },
      { name: "chicken stock", quantity: "1.2L" },
      { name: "egg noodles", quantity: "150g" },
      { name: "carrots", quantity: "2" },
    ],
  },
  {
    name: "BBQ Pulled Chicken",
    description: "Slow-cooked shredded chicken in smoky BBQ sauce.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 5.9,
    instructions: [
      "Slow-cook chicken thighs with BBQ sauce and stock for 3-4 hours.",
      "Shred the chicken and mix back through the sauce.",
      "Serve in brioche buns with coleslaw.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "600g" },
      { name: "BBQ sauce", quantity: "200ml" },
      { name: "brioche buns", quantity: "2" },
      { name: "coleslaw", quantity: "150g" },
    ],
  },
  {
    name: "Chicken Fried Rice",
    description: "Quick fried rice with chicken, egg and vegetables.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 4.1,
    instructions: [
      "Fry diced chicken until cooked, set aside.",
      "Scramble an egg in the same pan, add cooked rice and vegetables.",
      "Combine with chicken and soy sauce, stir fry until hot.",
    ],
    ingredients: [
      { name: "chicken breast", quantity: "300g" },
      { name: "cooked rice", quantity: "400g" },
      { name: "frozen peas and carrots", quantity: "150g" },
      { name: "eggs", quantity: "2" },
    ],
  },
  {
    name: "Coq au Vin",
    description: "French braised chicken in red wine with mushrooms and bacon.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 9.8,
    instructions: [
      "Brown chicken thighs and lardons in a casserole.",
      "Add shallots, mushrooms, red wine and stock.",
      "Cover and simmer 45 minutes until chicken is tender.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "6" },
      { name: "bacon lardons", quantity: "150g" },
      { name: "red wine", quantity: "300ml" },
      { name: "chestnut mushrooms", quantity: "200g" },
    ],
  },
  {
    name: "Honey Garlic Chicken Thighs",
    description: "Sticky honey garlic glazed chicken thighs.",
    primaryProtein: "chicken",
    isClassic: false,
    costTwoPerson: 4.4,
    instructions: [
      "Sear chicken thighs skin-side down until golden.",
      "Add honey, soy sauce and garlic, simmer until sticky and cooked through.",
      "Serve with rice and greens.",
    ],
    ingredients: [
      { name: "chicken thighs", quantity: "6" },
      { name: "honey", quantity: "3 tbsp" },
      { name: "soy sauce", quantity: "3 tbsp" },
      { name: "garlic", quantity: "3 cloves" },
    ],
  },

  // --- Pork ---
  {
    name: "Sausage and Mash",
    description: "Pork sausages with creamy mash and onion gravy.",
    primaryProtein: "pork",
    isClassic: true,
    costTwoPerson: 3.9,
    instructions: [
      "Grill or fry 6 pork sausages until browned and cooked through.",
      "Boil and mash potatoes with butter and milk.",
      "Make onion gravy, serve together.",
    ],
    ingredients: [
      { name: "pork sausages", quantity: "6" },
      { name: "potatoes", quantity: "700g" },
      { name: "onion", quantity: "1" },
      { name: "beef stock", quantity: "300ml" },
    ],
  },
  {
    name: "Pulled Pork Buns",
    description: "Slow-cooked shredded pork shoulder in barbecue buns.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 6.3,
    instructions: [
      "Slow-cook pork shoulder with BBQ rub for 4-5 hours until tender.",
      "Shred the pork and mix with BBQ sauce.",
      "Serve in brioche buns with slaw.",
    ],
    ingredients: [
      { name: "pork shoulder", quantity: "700g" },
      { name: "BBQ sauce", quantity: "200ml" },
      { name: "brioche buns", quantity: "2" },
      { name: "coleslaw", quantity: "150g" },
    ],
  },
  {
    name: "Pork Belly Bao",
    description: "Steamed bao buns filled with crispy pork belly.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 8.2,
    instructions: [
      "Roast pork belly slices until crispy.",
      "Steam bao buns according to packet instructions.",
      "Fill buns with pork, pickled cucumber and hoisin sauce.",
    ],
    ingredients: [
      { name: "pork belly slices", quantity: "400g" },
      { name: "bao buns", quantity: "6" },
      { name: "hoisin sauce", quantity: "4 tbsp" },
      { name: "cucumber", quantity: "1" },
    ],
  },
  {
    name: "Sweet and Sour Pork",
    description: "Crispy pork with pineapple in a tangy sauce.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 5.7,
    instructions: [
      "Coat diced pork loin in cornflour and fry until crisp.",
      "Stir fry peppers and pineapple, add sweet and sour sauce.",
      "Combine with pork, serve with rice.",
    ],
    ingredients: [
      { name: "pork loin", quantity: "400g" },
      { name: "tinned pineapple", quantity: "1 tin" },
      { name: "mixed peppers", quantity: "2" },
      { name: "rice", quantity: "300g" },
    ],
  },
  {
    name: "Toad in the Hole",
    description: "Pork sausages baked in a golden Yorkshire pudding batter.",
    primaryProtein: "pork",
    isClassic: true,
    costTwoPerson: 4.3,
    instructions: [
      "Brown 6 sausages in a hot ovenproof pan with oil.",
      "Pour over a batter of flour, eggs and milk.",
      "Bake at 220C for 25-30 minutes until risen and golden.",
    ],
    ingredients: [
      { name: "pork sausages", quantity: "6" },
      { name: "plain flour", quantity: "140g" },
      { name: "eggs", quantity: "4" },
      { name: "milk", quantity: "200ml" },
    ],
  },
  {
    name: "Pork Chops with Apple Sauce",
    description: "Pan-fried pork chops with a classic apple sauce.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 5.9,
    instructions: [
      "Season and pan-fry two pork chops until cooked through.",
      "Simmer chopped apple with a little sugar and water until soft.",
      "Serve chops with apple sauce and greens.",
    ],
    ingredients: [
      { name: "pork chops", quantity: "2" },
      { name: "cooking apples", quantity: "2" },
      { name: "green beans", quantity: "200g" },
    ],
  },
  {
    name: "Chorizo and Bean Stew",
    description: "Smoky chorizo simmered with butter beans and tomatoes.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 4.1,
    instructions: [
      "Fry sliced chorizo until it releases its oils.",
      "Add onion, garlic, chopped tomatoes and butter beans.",
      "Simmer 20 minutes, serve with crusty bread.",
    ],
    ingredients: [
      { name: "chorizo", quantity: "200g" },
      { name: "butter beans", quantity: "1 tin" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "onion", quantity: "1" },
    ],
  },
  {
    name: "Pork Katsu Curry",
    description: "Crispy breaded pork loin with a mild curry sauce.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 6.4,
    instructions: [
      "Coat pork loin steaks in flour, egg and panko breadcrumbs.",
      "Fry until golden and cooked through, slice.",
      "Serve over rice with a curry sauce.",
    ],
    ingredients: [
      { name: "pork loin steaks", quantity: "2" },
      { name: "panko breadcrumbs", quantity: "100g" },
      { name: "curry powder", quantity: "2 tbsp" },
      { name: "rice", quantity: "300g" },
    ],
  },
  {
    name: "Bacon Carbonara",
    description: "Creamy pasta with crispy bacon, egg and parmesan.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 5.5,
    instructions: [
      "Cook 300g spaghetti until al dente.",
      "Fry bacon lardons until crisp.",
      "Off the heat, toss pasta with bacon, beaten egg and parmesan to create a creamy sauce.",
    ],
    ingredients: [
      { name: "spaghetti", quantity: "300g" },
      { name: "bacon lardons", quantity: "150g" },
      { name: "eggs", quantity: "3" },
      { name: "parmesan", quantity: "80g" },
    ],
  },
  {
    name: "Honey Mustard Pork Tenderloin",
    description: "Roasted pork tenderloin glazed with honey and mustard.",
    primaryProtein: "pork",
    isClassic: false,
    costTwoPerson: 8.9,
    instructions: [
      "Sear a pork tenderloin on all sides.",
      "Brush with honey mustard glaze, roast at 200C for 20 minutes.",
      "Rest, slice and serve with roasted vegetables.",
    ],
    ingredients: [
      { name: "pork tenderloin", quantity: "500g" },
      { name: "honey", quantity: "2 tbsp" },
      { name: "dijon mustard", quantity: "2 tbsp" },
      { name: "mixed vegetables", quantity: "400g" },
    ],
  },

  // --- Lamb ---
  {
    name: "Lamb Kofta with Flatbread",
    description: "Spiced lamb koftas with flatbread and yoghurt sauce.",
    primaryProtein: "lamb",
    isClassic: true,
    costTwoPerson: 6.9,
    instructions: [
      "Mix lamb mince with cumin, coriander and garlic, shape into koftas.",
      "Grill or fry until cooked through.",
      "Serve in warm flatbreads with yoghurt sauce and salad.",
    ],
    ingredients: [
      { name: "lamb mince", quantity: "400g" },
      { name: "flatbreads", quantity: "4" },
      { name: "natural yoghurt", quantity: "150g" },
      { name: "cucumber", quantity: "1" },
    ],
  },
  {
    name: "Shepherd's Pie",
    description: "Lamb mince in gravy topped with creamy mashed potato.",
    primaryProtein: "lamb",
    isClassic: true,
    costTwoPerson: 5.8,
    instructions: [
      "Brown 400g lamb mince with onion and carrot.",
      "Add stock and Worcestershire sauce, simmer 20 minutes.",
      "Top with mashed potato and bake at 200C for 20 minutes.",
    ],
    ingredients: [
      { name: "lamb mince", quantity: "400g" },
      { name: "potatoes", quantity: "700g" },
      { name: "lamb stock", quantity: "300ml" },
      { name: "carrots", quantity: "2" },
    ],
  },
  {
    name: "Lamb Rogan Josh",
    description: "Slow-cooked lamb curry in a rich tomato and spice sauce.",
    primaryProtein: "lamb",
    isClassic: false,
    costTwoPerson: 8.6,
    instructions: [
      "Brown 500g diced lamb shoulder, set aside.",
      "Fry onion, garlic, ginger and rogan josh spices.",
      "Return lamb with chopped tomatoes, simmer 1.5 hours until tender.",
    ],
    ingredients: [
      { name: "diced lamb shoulder", quantity: "500g" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "rogan josh curry paste", quantity: "3 tbsp" },
      { name: "rice", quantity: "300g" },
    ],
  },
  {
    name: "Slow Roast Lamb Shoulder",
    description: "Melt-in-the-mouth lamb shoulder roasted low and slow.",
    primaryProtein: "lamb",
    isClassic: false,
    costTwoPerson: 13.5,
    instructions: [
      "Rub a lamb shoulder with garlic, rosemary and oil.",
      "Roast at 150C for 4-5 hours until falling apart.",
      "Rest, shred and serve with roasted vegetables.",
    ],
    ingredients: [
      { name: "lamb shoulder", quantity: "1.5kg" },
      { name: "garlic", quantity: "1 bulb" },
      { name: "rosemary", quantity: "4 sprigs" },
      { name: "potatoes", quantity: "600g" },
    ],
  },
  {
    name: "Lamb Koftas Curry",
    description: "Lamb koftas simmered in a spiced curry sauce.",
    primaryProtein: "lamb",
    isClassic: false,
    costTwoPerson: 7.2,
    instructions: [
      "Shape spiced lamb mince into koftas, fry until browned.",
      "Make a curry sauce with onion, garlic and tomatoes.",
      "Simmer koftas in the sauce for 15 minutes, serve with rice.",
    ],
    ingredients: [
      { name: "lamb mince", quantity: "400g" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "curry powder", quantity: "2 tbsp" },
      { name: "rice", quantity: "300g" },
    ],
  },
  {
    name: "Greek Lamb Souvlaki",
    description: "Grilled marinated lamb skewers with pitta and tzatziki.",
    primaryProtein: "lamb",
    isClassic: false,
    costTwoPerson: 6.6,
    instructions: [
      "Marinate cubed lamb leg in lemon, garlic and oregano.",
      "Skewer and grill until charred and cooked through.",
      "Serve with warm pitta, tzatziki and salad.",
    ],
    ingredients: [
      { name: "lamb leg", quantity: "400g" },
      { name: "pitta bread", quantity: "4" },
      { name: "tzatziki", quantity: "150g" },
      { name: "lemon", quantity: "1" },
    ],
  },
  {
    name: "Lamb and Mint Burgers",
    description: "Juicy lamb patties with fresh mint and feta.",
    primaryProtein: "lamb",
    isClassic: false,
    costTwoPerson: 6.1,
    instructions: [
      "Mix lamb mince with chopped mint, garlic and crumbled feta.",
      "Shape into patties and grill or fry until cooked through.",
      "Serve in buns with salad and yoghurt sauce.",
    ],
    ingredients: [
      { name: "lamb mince", quantity: "400g" },
      { name: "feta cheese", quantity: "80g" },
      { name: "mint", quantity: "1 handful" },
      { name: "burger buns", quantity: "2" },
    ],
  },
  {
    name: "Moroccan Lamb Tagine",
    description: "Fragrant slow-cooked lamb with apricots and spices.",
    primaryProtein: "lamb",
    isClassic: false,
    costTwoPerson: 9.9,
    instructions: [
      "Brown diced lamb shoulder with onion and Moroccan spices.",
      "Add stock, dried apricots and chickpeas.",
      "Simmer covered for 1.5-2 hours until tender, serve with couscous.",
    ],
    ingredients: [
      { name: "diced lamb shoulder", quantity: "500g" },
      { name: "dried apricots", quantity: "100g" },
      { name: "chickpeas", quantity: "1 tin" },
      { name: "couscous", quantity: "250g" },
    ],
  },

  // --- A few others, for protein-rotation variety ---
  {
    name: "Veggie Chilli",
    description: "Hearty bean and lentil chilli.",
    primaryProtein: "lentils",
    isClassic: true,
    costTwoPerson: 3.1,
    instructions: [
      "Fry onion, pepper and garlic until soft.",
      "Add chilli powder, cumin, tinned tomatoes, kidney beans and lentils.",
      "Simmer 25 minutes, season to taste, serve with rice.",
    ],
    ingredients: [
      { name: "kidney beans", quantity: "1 tin" },
      { name: "red lentils", quantity: "150g" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "bell pepper", quantity: "1" },
      { name: "onion", quantity: "1" },
    ],
  },
  {
    name: "Fish and Chips",
    description: "Beer-battered fish with chunky chips.",
    primaryProtein: "fish",
    isClassic: true,
    costTwoPerson: 7.5,
    instructions: [
      "Cut potatoes into chips, parboil, then roast or fry until golden.",
      "Make a beer batter and coat two fish fillets.",
      "Fry fish until golden and cooked through, serve with peas.",
    ],
    ingredients: [
      { name: "white fish fillets", quantity: "2" },
      { name: "potatoes", quantity: "800g" },
      { name: "plain flour", quantity: "150g" },
      { name: "beer", quantity: "200ml" },
      { name: "frozen peas", quantity: "200g" },
    ],
  },
  {
    name: "Salmon Teriyaki",
    description: "Pan-glazed salmon fillets with a sticky teriyaki sauce.",
    primaryProtein: "fish",
    isClassic: false,
    costTwoPerson: 8.8,
    instructions: [
      "Pan-fry two salmon fillets skin-side down until crisp.",
      "Add teriyaki sauce, glaze the salmon as it finishes cooking.",
      "Serve with rice and steamed greens.",
    ],
    ingredients: [
      { name: "salmon fillets", quantity: "2" },
      { name: "teriyaki sauce", quantity: "80ml" },
      { name: "rice", quantity: "250g" },
      { name: "pak choi", quantity: "2" },
    ],
  },
  {
    name: "Prawn Linguine",
    description: "Garlicky prawns tossed with linguine and chilli.",
    primaryProtein: "prawns",
    isClassic: false,
    costTwoPerson: 9.2,
    instructions: [
      "Cook 250g linguine until al dente.",
      "Fry king prawns with garlic, chilli and butter.",
      "Toss with pasta, a splash of pasta water and parsley.",
    ],
    ingredients: [
      { name: "linguine", quantity: "250g" },
      { name: "king prawns", quantity: "300g" },
      { name: "garlic", quantity: "3 cloves" },
      { name: "chilli flakes", quantity: "1 tsp" },
    ],
  },
  {
    name: "Turkey Meatballs",
    description: "Lean turkey meatballs in a tomato sauce.",
    primaryProtein: "turkey",
    isClassic: false,
    costTwoPerson: 4.7,
    instructions: [
      "Shape turkey mince with breadcrumbs and herbs into meatballs.",
      "Fry until browned, then simmer in tomato sauce for 15 minutes.",
      "Serve with spaghetti or crusty bread.",
    ],
    ingredients: [
      { name: "turkey mince", quantity: "400g" },
      { name: "chopped tomatoes", quantity: "1 tin" },
      { name: "breadcrumbs", quantity: "50g" },
      { name: "spaghetti", quantity: "250g" },
    ],
  },
  {
    name: "Tofu Stir Fry",
    description: "Quick veg and tofu stir fry with soy-ginger sauce.",
    primaryProtein: "tofu",
    isClassic: false,
    costTwoPerson: 3.6,
    instructions: [
      "Press and cube 400g firm tofu, fry until golden.",
      "Stir fry mixed vegetables in a hot wok.",
      "Add soy sauce, ginger, garlic and a splash of sesame oil, combine with tofu and noodles.",
    ],
    ingredients: [
      { name: "firm tofu", quantity: "400g" },
      { name: "mixed stir fry vegetables", quantity: "300g" },
      { name: "noodles", quantity: "250g" },
      { name: "soy sauce", quantity: "3 tbsp" },
    ],
  },
  {
    name: "Halloumi Buddha Bowl",
    description: "Grilled halloumi with roasted vegetables and grains.",
    primaryProtein: "halloumi",
    isClassic: false,
    costTwoPerson: 5.3,
    instructions: [
      "Roast mixed vegetables at 200C for 25 minutes.",
      "Grill sliced halloumi until golden.",
      "Serve over cooked grains with a drizzle of tahini dressing.",
    ],
    ingredients: [
      { name: "halloumi", quantity: "225g" },
      { name: "mixed vegetables", quantity: "400g" },
      { name: "couscous", quantity: "200g" },
      { name: "tahini", quantity: "2 tbsp" },
    ],
  },
  {
    name: "Mushroom Risotto",
    description: "Creamy arborio rice with mushrooms and parmesan.",
    primaryProtein: "mushroom",
    isClassic: false,
    costTwoPerson: 5.1,
    instructions: [
      "Fry mushrooms and onion, set mushrooms aside.",
      "Toast arborio rice, gradually add hot stock, stirring until creamy.",
      "Stir through mushrooms and parmesan, season and serve.",
    ],
    ingredients: [
      { name: "arborio rice", quantity: "250g" },
      { name: "chestnut mushrooms", quantity: "300g" },
      { name: "vegetable stock", quantity: "1L" },
      { name: "parmesan", quantity: "60g" },
    ],
  },
];

async function seed() {
  for (const m of DEMO_MEALS) {
    const tier = tierForCost(m.costTwoPerson);
    const [inserted] = await db
      .insert(meals)
      .values({
        name: m.name,
        description: m.description,
        instructions: m.instructions,
        primaryProtein: m.primaryProtein,
        isClassic: m.isClassic,
        costTwoPerson: String(m.costTwoPerson),
        costOnePerson: String(Math.round((m.costTwoPerson / 2) * 100) / 100),
        tier: tier ?? undefined,
      })
      .returning({ id: meals.id });

    await db.insert(mealIngredients).values(
      m.ingredients.map((i) => ({
        mealId: inserted.id,
        genericName: i.name,
        quantity: i.quantity,
      }))
    );
  }
  console.log(`Seeded ${DEMO_MEALS.length} demo meals.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
